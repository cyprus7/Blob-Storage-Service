param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^blob-smoke-[a-f0-9]{12}$')]
    [string]$Namespace
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-ExitCode([string]$step) {
    if ($LASTEXITCODE -ne 0) { throw "$step failed (exit code $LASTEXITCODE)" }
}

function New-RandomHex([int]$byteCount) {
    $bytes = [byte[]]::new($byteCount)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    return [Convert]::ToHexString($bytes).ToLowerInvariant()
}

$server = (& kubectl --context docker-desktop config view --minify -o 'jsonpath={.clusters[0].cluster.server}').Trim()
Assert-ExitCode 'Docker Desktop context lookup'
if ($server -ne 'https://kubernetes.docker.internal:6443') { throw "Unexpected Kubernetes endpoint: $server" }

$namespaceJson = & kubectl --context docker-desktop get namespace $Namespace -o json
Assert-ExitCode 'Namespace lookup'
$runLabel = ($namespaceJson | ConvertFrom-Json).metadata.labels.'blob-smoke-run'
if ($runLabel -notmatch "^$($Namespace.Substring('blob-smoke-'.Length))[a-f0-9]{20}$") {
    throw "Namespace $Namespace does not have its matching smoke ownership label"
}

$dbName = "blob_upgrade_$(New-RandomHex 4)"
& kubectl --context docker-desktop -n $Namespace exec deployment/postgres -- createdb -U blob_user $dbName
Assert-ExitCode 'Upgrade database creation'

try {
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
    foreach ($name in @('0000_curious_piledriver.sql', '0001_swift_crusher_hogan.sql')) {
        Get-Content -LiteralPath (Join-Path $repoRoot "migrations/blob-service/$name") -Raw |
            & kubectl --context docker-desktop -n $Namespace exec -i deployment/postgres -- psql -U blob_user -d $dbName -v ON_ERROR_STOP=1
        Assert-ExitCode "Apply $name"
    }
    Get-Content -LiteralPath (Join-Path $PSScriptRoot 'upgrade-fixture.sql') -Raw |
        & kubectl --context docker-desktop -n $Namespace exec -i deployment/postgres -- psql -U blob_user -d $dbName -v ON_ERROR_STOP=1
    Assert-ExitCode 'Pre-0002 legacy and v2 fixtures'

    & kubectl --context docker-desktop -n $Namespace exec deployment/blob-service -- sh -c 'BLOB_PG_URL="${BLOB_PG_URL%/*}/$1" npm run migrate:blob' sh $dbName
    Assert-ExitCode 'Runtime image applies 0002 over existing data'

    $checkSql = @'
SELECT
  (SELECT count(*) = 1 FROM blobs WHERE id = '00000000-0000-4000-8000-000000000111'
     AND generation = 1 AND storage_key = 'objects/sha256/aa/legacy-migration-fixture.txt')
  AND (SELECT count(*) = 1 FROM blob_objects WHERE id = '00000000-0000-4000-8000-000000000101'
     AND unreferenced_at IS NULL)
  AND (SELECT count(*) = 1 FROM blob_objects WHERE id = '00000000-0000-4000-8000-000000000102'
     AND unreferenced_at BETWEEN now() - interval '2 minutes' AND now())
  AND (SELECT count(*) = 1 FROM blobs WHERE id = '00000000-0000-4000-8000-000000000202'
     AND deleted_at IS NOT NULL AND object_id = '00000000-0000-4000-8000-000000000102')
  AND (SELECT count(*) = 3 FROM blob_schema_migrations);
'@
    $backfill = (& kubectl --context docker-desktop -n $Namespace exec deployment/postgres -- psql -U blob_user -d $dbName -At -c $checkSql).Trim()
    Assert-ExitCode '0002 backfill query'
    if ($backfill -ne 't') { throw "0002 backfill did not preserve references correctly: $backfill" }

    $fkSql = @'
DELETE FROM blob_objects WHERE id = '00000000-0000-4000-8000-000000000102';
SELECT count(*) = 1 FROM blobs WHERE id = '00000000-0000-4000-8000-000000000202'
  AND object_id IS NULL AND deleted_at IS NOT NULL;
'@
    $fk = @(& kubectl --context docker-desktop -n $Namespace exec deployment/postgres -- psql -U blob_user -d $dbName -At -v ON_ERROR_STOP=1 -c $fkSql)
    Assert-ExitCode '0002 FK SET NULL query'
    if ($fk[-1] -ne 't') { throw "0002 FK did not preserve soft-deleted handle: $($fk -join ',')" }
    Write-Host "PASS: 0002 preserved legacy and active v2, backfilled orphan with fresh grace, FK SET NULL retained soft-deleted handle in $Namespace"
} finally {
    & kubectl --context docker-desktop -n $Namespace exec deployment/postgres -- dropdb -U blob_user $dbName
    Assert-ExitCode 'Upgrade database cleanup'
}
