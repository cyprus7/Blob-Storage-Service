param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^blob-smoke-[a-f0-9]{12}$')]
    [string]$Namespace,
    [ValidateSet('core', 'edge')]
    [string]$Scenario = 'core'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Get-Command kubectl -ErrorAction SilentlyContinue)) {
    throw 'kubectl is required'
}

$server = (& kubectl --context docker-desktop config view --minify -o 'jsonpath={.clusters[0].cluster.server}').Trim()
if ($LASTEXITCODE -ne 0 -or $server -ne 'https://kubernetes.docker.internal:6443') {
    throw "Unexpected Docker Desktop API endpoint: $server"
}

$namespaceJson = & kubectl --context docker-desktop get namespace $Namespace -o json
if ($LASTEXITCODE -ne 0) { throw "Namespace $Namespace was not found" }
$runLabel = ($namespaceJson | ConvertFrom-Json).metadata.labels.'blob-smoke-run'
if ($runLabel -notmatch "^$($Namespace.Substring('blob-smoke-'.Length))[a-f0-9]{20}$") {
    throw "Namespace $Namespace does not have its matching smoke ownership label"
}

$image = (& kubectl --context docker-desktop -n $Namespace get deployment blob-service -o 'jsonpath={.spec.template.spec.containers[0].image}').Trim()
if ($LASTEXITCODE -ne 0 -or $image -notmatch '^blob-storage-service:local-smoke-') {
    throw "Unexpected local blob-service image: $image"
}

$scriptFile = if ($Scenario -eq 'edge') { 'gc-edge-smoke.cjs' } else { 'gc-smoke.cjs' }
$script = Get-Content -LiteralPath (Join-Path $PSScriptRoot $scriptFile) -Raw
$script | & kubectl --context docker-desktop -n $Namespace exec -i deployment/blob-service -- node -
if ($LASTEXITCODE -ne 0) { throw "GC smoke failed in $Namespace" }
Write-Host "PASS: GC $Scenario smoke in local namespace $Namespace (namespace retained)"
