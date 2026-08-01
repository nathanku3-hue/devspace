[CmdletBinding()]
param(
    [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = "Stop"
$repository = (Resolve-Path $RepositoryRoot).Path
$packageJson = Join-Path $repository "package.json"
$cliPath = Join-Path $repository "dist\cli.js"
$serverPath = Join-Path $repository "dist\server.js"

if (!(Test-Path $packageJson)) {
    Write-Error "DevSpace repository not found at '$repository'."
    exit 1
}

Write-Host "Building local DevSpace package..."
& npm.cmd --prefix $repository run build
if ($LASTEXITCODE -ne 0) {
    Write-Error "DevSpace build failed. The server was not started."
    exit 1
}

if (!(Test-Path $cliPath) -or !(Test-Path $serverPath)) {
    Write-Error "DevSpace build output is missing. Expected '$cliPath' and '$serverPath'."
    exit 1
}

$expectedTools = @(
    "bash",
    "close_workspace",
    "edit",
    "open_workspace",
    "publish_git_changes",
    "read",
    "read_files",
    "safe_rename_file",
    "web_connector_probe",
    "web_connector_proof",
    "web_launch",
    "write"
)
$builtJavascript = @(
    Get-ChildItem -Path (Join-Path $repository "dist") -Filter "*.js" -Recurse -File
).FullName
if ($builtJavascript.Count -eq 0) {
    Write-Error "Built DevSpace JavaScript output is missing under '$(Join-Path $repository "dist")'. Refusing to start."
    exit 1
}
$missingToolMarkers = @()
foreach ($toolName in $expectedTools) {
    $quotedPattern = '"' + [regex]::Escape($toolName) + '"'
    if (!(Select-String -Path $builtJavascript -Pattern $quotedPattern -Quiet)) {
        $missingToolMarkers += $toolName
    }
}
if ($missingToolMarkers.Count -gt 0) {
    Write-Error "Built DevSpace server is missing expected MCP tool markers: $($missingToolMarkers -join ', '). Refusing to start."
    exit 1
}
Write-Host "Verified built MCP tool markers: $($expectedTools.Count)/$($expectedTools.Count)"
Write-Host "Live authenticated tools/list checks remain authoritative and run after startup."

$ghCommand = Get-Command gh.exe -ErrorAction SilentlyContinue
if ($null -eq $ghCommand) {
    Write-Warning "GitHub CLI was not found. Git push requires another pre-authenticated credential helper or SSH key."
} else {
    & $ghCommand.Source auth status --hostname github.com *> $null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Verified GitHub CLI authentication."
    } else {
        Write-Warning "GitHub CLI is not authenticated. DevSpace can commit, but HTTPS push may fail non-interactively."
    }
}
