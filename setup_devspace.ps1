# Compatibility launcher. Production operators should use E:\Code\devspace\setup_devspace.ps1.
param(
    [switch]$Monitor,
    [switch]$Stop,
    [switch]$Reregister,
    [switch]$AllowDirty,
    [switch]$OverridePreferredSource,
    [switch]$PinPreferredSource
)

$canonicalScript = Join-Path $PSScriptRoot "scripts\setup-devspace.ps1"
if (!(Test-Path -LiteralPath $canonicalScript -PathType Leaf)) {
    Write-Error "Canonical DevSpace setup script not found at '$canonicalScript'."
    exit 1
}

$forwardedArguments = @()
if ($Monitor) { $forwardedArguments += "-Monitor" }
if ($Stop) { $forwardedArguments += "-Stop" }
if ($Reregister) { $forwardedArguments += "-Reregister" }
if ($AllowDirty) { $forwardedArguments += "-AllowDirty" }
if ($OverridePreferredSource) { $forwardedArguments += "-OverridePreferredSource" }
if ($PinPreferredSource) { $forwardedArguments += "-PinPreferredSource" }

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $canonicalScript @forwardedArguments
exit $LASTEXITCODE
