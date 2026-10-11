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

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$migrationsDir = Join-Path $repoRoot 'migrations/blob-service'
$sqlFiles = @(Get-ChildItem -LiteralPath $migrationsDir -Filter '*.sql' -File | Sort-Object Name)
if ($sqlFiles.Count -eq 0) {
    throw "No blob SQL migrations found in $migrationsDir"
}

$runId = (New-RandomHex 16)
$namespace = "blob-smoke-$($runId.Substring(0, 12))"
$image = "blob-storage-service:local-smoke-$($runId.Substring(0, 12))"
$createdNamespace = $false
$portForward = $null
$portForwardOut = Join-Path ([System.IO.Path]::GetTempPath()) "$namespace-port-forward.out.log"
$portForwardErr = Join-Path ([System.IO.Path]::GetTempPath()) "$namespace-port-forward.err.log"
$oldBaseUrl = [Environment]::GetEnvironmentVariable('BLOB_SMOKE_BASE_URL', 'Process')
$oldApiKey = [Environment]::GetEnvironmentVariable('BLOB_SMOKE_API_KEY', 'Process')

try {
    foreach ($commandName in @('docker', 'kubectl', 'node')) {
        if (-not (Get-Command $commandName -ErrorAction SilentlyContinue)) {
            throw "$commandName is required"
        }
    }

    # The user's default kubeconfig context points to a remote cluster. The
    # explicit context and endpoint check are mandatory before any mutation.
    $server = (& kubectl --context docker-desktop config view --minify -o 'jsonpath={.clusters[0].cluster.server}').Trim()
    Assert-ExitCode 'Docker Desktop kubeconfig lookup'
    if ($server -ne 'https://kubernetes.docker.internal:6443') {
        throw "Unexpected Docker Desktop API endpoint: $server"
    }

    $dockerName = (& docker --context desktop-linux info --format '{{.Name}}').Trim()
    Assert-ExitCode 'Docker Desktop engine lookup'
    if ($dockerName -ne 'docker-desktop') {
        throw "Unexpected Docker engine: $dockerName"
    }

    $nodeVersion = (& node --version).Trim()
    Assert-ExitCode 'Node version lookup'
    if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 20) {
        throw 'Node 20 or newer is required for the HTTP smoke test'
    }

    Write-Host "Building $image from $repoRoot"
    & docker --context desktop-linux build --pull=false -t $image $repoRoot
    Assert-ExitCode 'Local blob-service image build'

    $namespaceManifest = @"
apiVersion: v1
kind: Namespace
metadata:
  name: $namespace
  labels:
    blob-smoke-run: $runId
"@
    $namespaceManifest | & kubectl --context docker-desktop create -f -
    Assert-ExitCode 'Isolated namespace creation'
    $createdNamespace = $true

    $postgresPassword = New-RandomHex 24
    $minioPassword = New-RandomHex 24
    $apiKey = New-RandomHex 24
    $secretManifest = @"
apiVersion: v1
kind: Secret
metadata:
  name: blob-smoke-secrets
  namespace: $namespace
type: Opaque
stringData:
  POSTGRES_PASSWORD: $postgresPassword
  MINIO_ROOT_PASSWORD: $minioPassword
  BLOB_PG_URL: postgresql://blob_user:${postgresPassword}@postgres:5432/blob_service
  BLOB_API_KEY: $apiKey
"@
    $secretManifest | & kubectl --context docker-desktop apply -f -
    Assert-ExitCode 'Ephemeral secret creation'

    $configMapArgs = @('--context', 'docker-desktop', '-n', $namespace, 'create', 'configmap', 'blob-migrations', '--dry-run=client', '-o', 'yaml')
    foreach ($sqlFile in $sqlFiles) {
        $configMapArgs += "--from-file=$($sqlFile.FullName)"
    }
    $configMapManifest = & kubectl @configMapArgs
    Assert-ExitCode 'Migration ConfigMap generation'
    $configMapManifest | & kubectl --context docker-desktop -n $namespace apply -f -
    Assert-ExitCode 'Migration ConfigMap creation'

    Invoke-Kubectl -arguments @('-n', $namespace, 'apply', '-f', (Join-Path $PSScriptRoot 'stack.yaml'))
    Invoke-Kubectl -arguments @('-n', $namespace, 'wait', '--for=condition=available', 'deployment/postgres', '--timeout=180s')
    Invoke-Kubectl -arguments @('-n', $namespace, 'wait', '--for=condition=available', 'deployment/minio', '--timeout=180s')

    Invoke-Kubectl -arguments @('-n', $namespace, 'apply', '-f', (Join-Path $PSScriptRoot 'migration-job.yaml'))
    Invoke-Kubectl -arguments @('-n', $namespace, 'wait', '--for=condition=complete', 'job/blob-migration', '--timeout=180s')

    # This row uses the pre-v2 default generation and has no backing S3 object.
    # Both delete modes must reject it before any physical storage action.
    Get-Content -LiteralPath (Join-Path $PSScriptRoot 'legacy-fixture.sql') -Raw |
        & kubectl --context docker-desktop -n $namespace exec -i deployment/postgres -- psql -U blob_user -d blob_service -v ON_ERROR_STOP=1
    Assert-ExitCode 'Legacy blob fixture insertion'

    $bucketManifest = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'bucket-job.yaml') -Raw).Replace('__BLOB_IMAGE__', $image)
    $bucketManifest | & kubectl --context docker-desktop -n $namespace apply -f -
    Assert-ExitCode 'Bucket Job creation'
    Invoke-Kubectl -arguments @('-n', $namespace, 'wait', '--for=condition=complete', 'job/blob-bucket', '--timeout=180s')

    $blobManifest = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'blob.yaml') -Raw).Replace('__BLOB_IMAGE__', $image)
    $blobManifest | & kubectl --context docker-desktop -n $namespace apply -f -
    Assert-ExitCode 'Blob-service Deployment creation'
    Invoke-Kubectl -arguments @('-n', $namespace, 'wait', '--for=condition=available', 'deployment/blob-service', '--timeout=180s')

    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $localPort = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    $listener.Stop()

    $kubectlExe = (Get-Command kubectl).Source
    $portForward = Start-Process -FilePath $kubectlExe -ArgumentList @(
        '--context', 'docker-desktop', '-n', $namespace,
        'port-forward', '--address=127.0.0.1', 'service/blob-service', "${localPort}:3100"
    ) -PassThru -WindowStyle Hidden -RedirectStandardOutput $portForwardOut -RedirectStandardError $portForwardErr

    $baseUrl = "http://127.0.0.1:$localPort"
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    $ready = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($portForward.HasExited) {
            throw 'kubectl port-forward exited before the service became reachable'
        }
        try {
            $response = Invoke-WebRequest -Uri "$baseUrl/health" -TimeoutSec 2
            if ($response.StatusCode -eq 200) {
                $ready = $true
                break
            }
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
    if (-not $ready) {
        throw 'Timed out waiting for localhost port-forward'
    }

    $env:BLOB_SMOKE_BASE_URL = $baseUrl
    $env:BLOB_SMOKE_API_KEY = $apiKey
    & node (Join-Path $PSScriptRoot 'smoke.mjs')
    Assert-ExitCode 'Blob HTTP smoke'

    # All accepted uploads in this fresh database use the same random bytes.
    # One handle was hard-deleted, leaving five v2 handles and one object.
    $countSql = "select (select count(*) from blob_objects)::text || ':' || (select count(*) from blobs where generation = 2)::text"
    $counts = (& kubectl --context docker-desktop -n $namespace exec deployment/postgres -- psql -U blob_user -d blob_service -At -c $countSql).Trim()
    Assert-ExitCode 'Physical/logical blob count query'
    if ($counts -ne '1:5') {
        throw "Expected one physical object and five v2 handles, got $counts"
    }
    Write-Host 'PASS: PostgreSQL has one physical object and five v2 handles'
    Write-Host "PASS: isolated Docker Desktop Kubernetes smoke in $namespace"
} catch {
    if ($createdNamespace) {
        Write-Warning "Smoke failed in $namespace; local pod status follows"
        & kubectl --context docker-desktop -n $namespace get pods -o wide
        & kubectl --context docker-desktop -n $namespace logs job/blob-migration --tail=60 2>$null
        & kubectl --context docker-desktop -n $namespace logs job/blob-bucket --tail=60 2>$null
        & kubectl --context docker-desktop -n $namespace logs deployment/blob-service --tail=60 2>$null
    }
    throw
} finally {
    if ($null -ne $oldBaseUrl) { $env:BLOB_SMOKE_BASE_URL = $oldBaseUrl } else { Remove-Item Env:BLOB_SMOKE_BASE_URL -ErrorAction SilentlyContinue }
    if ($null -ne $oldApiKey) { $env:BLOB_SMOKE_API_KEY = $oldApiKey } else { Remove-Item Env:BLOB_SMOKE_API_KEY -ErrorAction SilentlyContinue }

    if ($null -ne $portForward -and -not $portForward.HasExited) {
        Stop-Process -Id $portForward.Id -ErrorAction SilentlyContinue
    }
    if ($createdNamespace) {
        if ($KeepNamespace) {
            Write-Host "Retained local namespace for inspection: $namespace"
        } else {
            $namespaceJson = & kubectl --context docker-desktop get namespace $namespace -o json 2>$null
            if ($LASTEXITCODE -eq 0) {
                $actualRunId = ($namespaceJson | ConvertFrom-Json).metadata.labels.'blob-smoke-run'
                if ($actualRunId -eq $runId) {
                    & kubectl --context docker-desktop delete namespace $namespace --wait=false
                } else {
                    Write-Warning "Namespace ownership label changed; leaving $namespace untouched"
                }
            }
        }
    }
    Remove-Item -LiteralPath $portForwardOut, $portForwardErr -ErrorAction SilentlyContinue
}
