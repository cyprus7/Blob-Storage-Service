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

function Test-ReadyStatus([int]$expected) {
    $source = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'ready-check.cjs') -Raw
    for ($attempt = 0; $attempt -lt 12; $attempt++) {
        $pod = (& kubectl --context docker-desktop -n $Namespace get pod -l app=blob-smoke-service -o 'jsonpath={.items[0].metadata.name}').Trim()
        Assert-ExitCode 'Blob Pod lookup'
        if ($pod) {
            $source | & kubectl --context docker-desktop -n $Namespace exec -i "pod/$pod" -- node - $expected
            if ($LASTEXITCODE -eq 0) { return }
        }
        Start-Sleep -Seconds 1
    }
    throw "Blob readiness did not reach HTTP $expected"
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

Test-ReadyStatus 200
foreach ($dependency in @('minio', 'postgres')) {
    try {
        & kubectl --context docker-desktop -n $Namespace scale "deployment/$dependency" --replicas=0
        Assert-ExitCode "$dependency scale down"
        & kubectl --context docker-desktop -n $Namespace wait --for=delete pod -l "app=blob-smoke-$dependency" --timeout=60s
        Assert-ExitCode "$dependency Pod removal"
        Test-ReadyStatus 503
        Write-Host "PASS: $dependency unavailable => /ready=503 while /health=200"
    } finally {
        & kubectl --context docker-desktop -n $Namespace scale "deployment/$dependency" --replicas=1
        Assert-ExitCode "$dependency restore"
        & kubectl --context docker-desktop -n $Namespace wait --for=condition=available "deployment/$dependency" --timeout=180s
        Assert-ExitCode "$dependency readiness after restore"
        if ($dependency -eq 'minio') {
            # MinIO uses emptyDir in this disposable namespace, so scaling it
            # to zero erases the bucket. Restore it before checking readiness.
            $pod = (& kubectl --context docker-desktop -n $Namespace get pod -l app=blob-smoke-service -o 'jsonpath={.items[0].metadata.name}').Trim()
            Assert-ExitCode 'Blob Pod lookup for bucket recreation'
            Get-Content -LiteralPath (Join-Path $PSScriptRoot 'recreate-bucket.cjs') -Raw |
                & kubectl --context docker-desktop -n $Namespace exec -i "pod/$pod" -- node -
            Assert-ExitCode 'Local MinIO bucket recreation'
        }
        Test-ReadyStatus 200
    }
}
Write-Host "PASS: dependency outage and recovery readiness smoke in local namespace $Namespace"
