# Operator-only stop. Not a model-facing launcher. MCP bash is denied this path.
# The supervised runtime process ACL intentionally requires an elevated operator.
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Stopping the protected DevSpace runtime requires an elevated operator console."
}

$canonical = Join-Path $PSScriptRoot "setup-devspace.ps1"
if (!(Test-Path -LiteralPath $canonical -PathType Leaf)) {
    throw "Canonical setup script not found: $canonical"
}

Write-Warning "Operator stop of the production origin. This is not available to MCP bash."
. $canonical -LibraryOnly
Stop-DevSpaceRuntime
