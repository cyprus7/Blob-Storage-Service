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

$server = (& kubectl --context docker-desktop config view --minify -o 'jsonpath={.clusters[0].cluster.server}').Trim()
Assert-ExitCode 'Docker Desktop context lookup'
if ($server -ne 'https://kubernetes.docker.internal:6443') { throw "Unexpected Kubernetes endpoint: $server" }
$namespaceJson = & kubectl --context docker-desktop get namespace $Namespace -o json
Assert-ExitCode 'Namespace lookup'
$runLabel = ($namespaceJson | ConvertFrom-Json).metadata.labels.'blob-smoke-run'
if ($runLabel -notmatch "^$($Namespace.Substring('blob-smoke-'.Length))[a-f0-9]{20}$") {
    throw "Namespace $Namespace does not have its matching smoke ownership label"
}

$secretBase64 = (& kubectl --context docker-desktop -n $Namespace get secret blob-smoke-secrets -o 'jsonpath={.data.BLOB_API_KEY}').Trim()
Assert-ExitCode 'Local API key lookup'
$apiKey = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($secretBase64))
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()
$kubectlExe = (Get-Command kubectl).Source
$forwardOut = Join-Path ([System.IO.Path]::GetTempPath()) "$Namespace-e2e-forward.out.log"
$forwardErr = Join-Path ([System.IO.Path]::GetTempPath()) "$Namespace-e2e-forward.err.log"
$oldPort = [Environment]::GetEnvironmentVariable('PORT', 'Process')
$oldApiKey = [Environment]::GetEnvironmentVariable('BLOB_API_KEY', 'Process')
$forward = $null

try {
    $forward = Start-Process -FilePath $kubectlExe -ArgumentList @(
        '--context', 'docker-desktop', '-n', $Namespace,
        'port-forward', '--address=127.0.0.1', 'service/blob-service', "${port}:3100"
    ) -PassThru -WindowStyle Hidden -RedirectStandardOutput $forwardOut -RedirectStandardError $forwardErr

    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    $reachable = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($forward.HasExited) { throw 'Local kubectl port-forward exited' }
        try {
            $health = Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -TimeoutSec 2
            if ($health.StatusCode -eq 200) { $reachable = $true; break }
        } catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $reachable) { throw 'Local blob-service did not become reachable' }

    $env:PORT = [string]$port
    $env:BLOB_API_KEY = $apiKey
    Push-Location $repoRoot
    try {
        & npm run test:e2e
        Assert-ExitCode 'Service e2e suite'
    } finally {
        Pop-Location
    }
    Write-Host "PASS: stock npm run test:e2e against Docker Desktop namespace $Namespace"
} finally {
    if ($null -ne $oldPort) { $env:PORT = $oldPort } else { Remove-Item Env:PORT -ErrorAction SilentlyContinue }
    if ($null -ne $oldApiKey) { $env:BLOB_API_KEY = $oldApiKey } else { Remove-Item Env:BLOB_API_KEY -ErrorAction SilentlyContinue }
    if ($null -ne $forward -and -not $forward.HasExited) { Stop-Process -Id $forward.Id -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $forwardOut, $forwardErr -ErrorAction SilentlyContinue
}
