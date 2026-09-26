# Compatibility launcher. Production operators should use E:\Code\devspace\setup_devspace.ps1.
# Model-facing: does not accept -Stop.
[CmdletBinding()]
param(
    [switch]$Monitor,
    [switch]$Reregister,
    [switch]$AllowDirty,
    [switch]$OverridePreferredSource,
    [switch]$PinPreferredSource
)
if ($MyInvocation.UnboundArguments -and $MyInvocation.UnboundArguments.Count -gt 0) {
    throw "Unexpected arguments: $($MyInvocation.UnboundArguments -join ' '). Model-facing setup does not accept -Stop."
}

$canonicalScript = Join-Path $PSScriptRoot "scripts\setup-devspace.ps1"
if (!(Test-Path -LiteralPath $canonicalScript -PathType Leaf)) {
    Write-Error "Canonical DevSpace setup script not found at '$canonicalScript'."
    exit 1
}

$forwardedArguments = @()
if ($Monitor) { $forwardedArguments += "-Monitor" }
if ($Reregister) { $forwardedArguments += "-Reregister" }
if ($AllowDirty) { $forwardedArguments += "-AllowDirty" }
if ($OverridePreferredSource) { $forwardedArguments += "-OverridePreferredSource" }
if ($PinPreferredSource) { $forwardedArguments += "-PinPreferredSource" }

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $canonicalScript @forwardedArguments
exit $LASTEXITCODE
