# Inert replacement for worktree copies of setup-devspace.ps1.
param(
    [switch]$Monitor,
    [switch]$Stop,
    [switch]$LibraryOnly,
    [Parameter(ValueFromRemainingArguments = $true)]
    $Ignored
)

if ($LibraryOnly) { return }

throw @"
Refusing production setup from a Git worktree copy:
  $PSCommandPath
Use only:
  powershell -ExecutionPolicy Bypass -File E:\Code\devspace\setup_devspace.ps1
This launcher does not accept -Stop.
"@
