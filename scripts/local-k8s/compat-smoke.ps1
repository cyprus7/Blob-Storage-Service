param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^blob-smoke-[a-f0-9]{12}$')]
    [string]$Namespace
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$server = (& kubectl --context docker-desktop config view --minify -o 'jsonpath={.clusters[0].cluster.server}').Trim()
if ($LASTEXITCODE -ne 0 -or $server -ne 'https://kubernetes.docker.internal:6443') {
    throw "Unexpected Docker Desktop endpoint: $server"
}
$namespaceJson = & kubectl --context docker-desktop get namespace $Namespace -o json
if ($LASTEXITCODE -ne 0) { throw "Namespace $Namespace does not exist" }
$runLabel = ($namespaceJson | ConvertFrom-Json).metadata.labels.'blob-smoke-run'
if ($runLabel -notmatch "^$($Namespace.Substring('blob-smoke-'.Length))[a-f0-9]{20}$") {
    throw "Namespace $Namespace does not have its matching smoke ownership label"
}

& kubectl --context docker-desktop -n $Namespace apply -f (Join-Path $PSScriptRoot 'old-blob.yaml')
if ($LASTEXITCODE -ne 0) { throw 'Pinned old Deployment creation failed' }
& kubectl --context docker-desktop -n $Namespace wait --for=condition=available deployment/old-blob-service --timeout=180s
if ($LASTEXITCODE -ne 0) {
    & kubectl --context docker-desktop -n $Namespace get pods -o wide
    & kubectl --context docker-desktop -n $Namespace logs deployment/old-blob-service --tail=80
    throw 'Pinned old Deployment was not available'
}

Get-Content -LiteralPath (Join-Path $PSScriptRoot 'compat-smoke.cjs') -Raw |
    & kubectl --context docker-desktop -n $Namespace exec -i deployment/blob-service -- node -
if ($LASTEXITCODE -ne 0) { throw 'Pinned image compatibility smoke failed' }
Write-Host "PASS: pinned image read compatibility in local namespace $Namespace"
