param(
    [switch]$KeepNamespace
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-ExitCode([string]$step) {
    if ($LASTEXITCODE -ne 0) {
        throw "$step failed (exit code $LASTEXITCODE)"
    }
}

function New-RandomHex([int]$byteCount) {
    $bytes = [byte[]]::new($byteCount)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    return [Convert]::ToHexString($bytes).ToLowerInvariant()
}

function Invoke-Kubectl([string[]]$arguments) {
    & kubectl --context docker-desktop @arguments
    Assert-ExitCode 'kubectl'
}

function New-ConfigMap([string]$name, [string[]]$files) {
    $createArgs = @('--context', 'docker-desktop', '-n', $namespace, 'create', 'configmap', $name, '--dry-run=client', '-o', 'yaml')
    foreach ($file in $files) {
        $createArgs += "--from-file=$file"
    }
    $manifest = & kubectl @createArgs
    Assert-ExitCode "$name ConfigMap generation"
    $manifest | & kubectl --context docker-desktop -n $namespace apply -f -
    Assert-ExitCode "$name ConfigMap creation"
}

function Start-MigrationJob([string]$name, [string]$configMapName) {
    $manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'migrator-job.yaml') -Raw
    $manifest = $manifest.Replace('__JOB_NAME__', $name).Replace('__CONFIGMAP_NAME__', $configMapName)
    $manifest | & kubectl --context docker-desktop -n $namespace apply -f -
    Assert-ExitCode "$name Job creation"
}

function Get-LedgerNames {
    $names = @(& kubectl --context docker-desktop -n $namespace exec deployment/postgres -- psql -U blob_user -d blob_service -At -c 'select name from blob_schema_migrations order by name')
    Assert-ExitCode 'Migration ledger query'
    return $names
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$migrationFiles = @(Get-ChildItem -LiteralPath (Join-Path $repoRoot 'migrations/blob-service') -Filter '*.sql' -File | Sort-Object Name)
if ($migrationFiles.Count -eq 0) {
    throw 'No blob SQL migrations found'
}
$expectedNames = @($migrationFiles | ForEach-Object { $_.Name })
$sourceFiles = @($migrationFiles | ForEach-Object { $_.FullName })
$runId = New-RandomHex 16
$namespace = "blob-migrate-$($runId.Substring(0, 12))"
$createdNamespace = $false

try {
    if (-not (Get-Command kubectl -ErrorAction SilentlyContinue)) {
        throw 'kubectl is required'
    }
    $server = (& kubectl --context docker-desktop config view --minify -o 'jsonpath={.clusters[0].cluster.server}').Trim()
    Assert-ExitCode 'Docker Desktop kubeconfig lookup'
    if ($server -ne 'https://kubernetes.docker.internal:6443') {
        throw "Unexpected Docker Desktop API endpoint: $server"
    }

    $namespaceManifest = @"
apiVersion: v1
kind: Namespace
metadata:
  name: $namespace
  labels:
    blob-migrate-run: $runId
"@
    $namespaceManifest | & kubectl --context docker-desktop create -f -
    Assert-ExitCode 'Migration namespace creation'
    $createdNamespace = $true

    $password = New-RandomHex 24
    $secretManifest = @"
apiVersion: v1
kind: Secret
metadata:
  name: migration-secrets
  namespace: $namespace
type: Opaque
stringData:
  POSTGRES_PASSWORD: $password
"@
    $secretManifest | & kubectl --context docker-desktop apply -f -
    Assert-ExitCode 'Migration secret creation'

    Invoke-Kubectl -arguments @('-n', $namespace, 'apply', '-f', (Join-Path $PSScriptRoot 'postgres-only.yaml'))
    Invoke-Kubectl -arguments @('-n', $namespace, 'wait', '--for=condition=available', 'deployment/postgres', '--timeout=180s')

    New-ConfigMap -name 'migration-runner' -files @((Join-Path $repoRoot 'scripts/apply-migrations.sh'))
    New-ConfigMap -name 'blob-migrations' -files $sourceFiles
    $badFiles = @($sourceFiles) + @(
        (Join-Path $PSScriptRoot '9999_failed_smoke.sql'),
        (Join-Path $PSScriptRoot '9999_following_smoke.sql')
    )
    New-ConfigMap -name 'blob-migrations-negative' -files $badFiles

    Start-MigrationJob -name 'migrate-first' -configMapName 'blob-migrations'
    Invoke-Kubectl -arguments @('-n', $namespace, 'wait', '--for=condition=complete', 'job/migrate-first', '--timeout=180s')
    $firstLog = (& kubectl --context docker-desktop -n $namespace logs job/migrate-first) -join "`n"
    Assert-ExitCode 'First migration Job logs'
    foreach ($name in $expectedNames) {
        if (-not $firstLog.Contains("Applying: $name")) {
            throw "First migration Job did not apply $name"
        }
    }
    if ((Get-LedgerNames) -join '|' -ne ($expectedNames -join '|')) {
        throw 'First migration ledger does not match source SQL files'
    }

    Start-MigrationJob -name 'migrate-repeat' -configMapName 'blob-migrations'
    Invoke-Kubectl -arguments @('-n', $namespace, 'wait', '--for=condition=complete', 'job/migrate-repeat', '--timeout=180s')
    $repeatLog = (& kubectl --context docker-desktop -n $namespace logs job/migrate-repeat) -join "`n"
    Assert-ExitCode 'Repeat migration Job logs'
    foreach ($name in $expectedNames) {
        if (-not $repeatLog.Contains("Already applied: $name")) {
            throw "Repeat migration Job did not skip $name"
        }
    }
    if ((Get-LedgerNames) -join '|' -ne ($expectedNames -join '|')) {
        throw 'Repeat migration changed the ledger'
    }

    Start-MigrationJob -name 'migrate-negative' -configMapName 'blob-migrations-negative'
    Invoke-Kubectl -arguments @('-n', $namespace, 'wait', '--for=condition=failed', 'job/migrate-negative', '--timeout=180s')
    $failureLog = (& kubectl --context docker-desktop -n $namespace logs job/migrate-negative) -join "`n"
    Assert-ExitCode 'Negative migration Job logs'
    if (-not $failureLog.Contains('Applying: 9999_failed_smoke.sql') -or
        -not $failureLog.Contains('ERROR:') -or
        $failureLog.Contains('Applying: 9999_following_smoke.sql')) {
        throw 'Negative migration Job did not stop at the invalid SQL'
    }
    if ((Get-LedgerNames) -join '|' -ne ($expectedNames -join '|')) {
        throw 'Invalid migration changed the ledger'
    }
    $rollbackSql = "select coalesce(to_regclass('public.migration_failed_marker')::text, 'missing') || ':' || coalesce(to_regclass('public.migration_should_not_run')::text, 'missing')"
    $rollback = (& kubectl --context docker-desktop -n $namespace exec deployment/postgres -- psql -U blob_user -d blob_service -At -c $rollbackSql).Trim()
    Assert-ExitCode 'Invalid migration rollback query'
    if ($rollback -ne 'missing:missing') {
        throw "Invalid migration was not rolled back or a following migration ran: $rollback"
    }

    Write-Host "PASS: first and repeat migration Jobs, ledger ($($expectedNames.Count) entries), fail-fast and rollback in $namespace"
} catch {
    if ($createdNamespace) {
        Write-Warning "Migration smoke failed in $namespace; local pod status follows"
        & kubectl --context docker-desktop -n $namespace get pods -o wide
        & kubectl --context docker-desktop -n $namespace logs job/migrate-first --tail=80 2>$null
        & kubectl --context docker-desktop -n $namespace logs job/migrate-repeat --tail=80 2>$null
        & kubectl --context docker-desktop -n $namespace logs job/migrate-negative --tail=80 2>$null
    }
    throw
} finally {
    if ($createdNamespace) {
        if ($KeepNamespace) {
            Write-Host "Retained local migration namespace for inspection: $namespace"
        } else {
            $namespaceJson = & kubectl --context docker-desktop get namespace $namespace -o json 2>$null
            if ($LASTEXITCODE -eq 0) {
                $actualRunId = ($namespaceJson | ConvertFrom-Json).metadata.labels.'blob-migrate-run'
                if ($actualRunId -eq $runId) {
                    & kubectl --context docker-desktop delete namespace $namespace --wait=false
                } else {
                    Write-Warning "Namespace ownership label changed; leaving $namespace untouched"
                }
            }
        }
    }
}
