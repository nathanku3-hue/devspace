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

if (!(Select-String -Path $serverPath -Pattern 'publish_git_changes' -SimpleMatch -Quiet)) {
    Write-Error "Built DevSpace server does not expose publish_git_changes. Refusing to start a Git-inspection-only tool surface."
    exit 1
}
Write-Host "Verified built MCP tool: publish_git_changes"

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
