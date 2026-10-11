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

& kubectl --context docker-desktop delete namespace $Namespace --wait=false
if ($LASTEXITCODE -ne 0) { throw "Could not delete owned namespace $Namespace" }
& kubectl --context docker-desktop wait --for=delete "namespace/$Namespace" --timeout=120s
if ($LASTEXITCODE -ne 0) { throw "Timed out waiting for owned namespace $Namespace deletion" }
Write-Host "PASS: removed only owned local namespace $Namespace"
