# Version-controlled compatibility launcher for the canonical setup implementation.
param(
    [switch]$Monitor,
    [switch]$Stop
)

$canonicalScript = Join-Path $PSScriptRoot "scripts\setup-devspace.ps1"
if (!(Test-Path -LiteralPath $canonicalScript -PathType Leaf)) {
    Write-Error "Canonical DevSpace setup script not found at '$canonicalScript'."
    exit 1
}

$forwardedArguments = @()
if ($Monitor) { $forwardedArguments += "-Monitor" }
if ($Stop) { $forwardedArguments += "-Stop" }

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $canonicalScript @forwardedArguments
exit $LASTEXITCODE
