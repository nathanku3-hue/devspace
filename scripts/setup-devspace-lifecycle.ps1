# Lifecycle helpers for DevSpace setup. Dot-sourced by setup-devspace.ps1 and tests.
# Sacred invariant: a verified local origin is never stopped or rebuilt to heal routing.

function ConvertTo-NormalizedDevSpacePath {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return ""
    }
    $full = [System.IO.Path]::GetFullPath($Path)
    return $full.TrimEnd('\', '/').ToLowerInvariant()
}

function Test-DevSpaceHealthzJson {
    param([string]$Body)

    if ([string]::IsNullOrWhiteSpace($Body)) {
        return $false
    }
    $trimmed = $Body.Trim()
    if (-not $trimmed.StartsWith("{")) {
        return $false
    }
    try {
        $parsed = $trimmed | ConvertFrom-Json
    } catch {
        return $false
    }
    if ($null -eq $parsed) {
        return $false
    }
    $okProperty = $parsed.PSObject.Properties['ok']
    $nameProperty = $parsed.PSObject.Properties['name']
    if ($null -eq $okProperty -or $null -eq $nameProperty) {
        return $false
    }
    if ($okProperty.Value -isnot [bool] -or $okProperty.Value -ne $true) {
        return $false
    }
    return [System.StringComparer]::Ordinal.Equals([string]$nameProperty.Value, "devspace")
}

function Test-DevSpaceGitWorktreePath {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $false
    }
    $normalized = ConvertTo-NormalizedDevSpacePath $Path
    if ($normalized -match '\\.worktrees\\') {
        return $true
    }
    if (-not (Test-Path -LiteralPath $Path)) {
        return $false
    }
    $gitEntry = Join-Path $Path ".git"
    if (Test-Path -LiteralPath $gitEntry -PathType Leaf) {
        return $true
    }
    if (-not (Test-Path -LiteralPath $gitEntry -PathType Container)) {
        return $false
    }

    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $gitDir = ((& git -C $Path rev-parse --git-dir 2>$null) | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($gitDir)) {
            return $false
        }
        $commonDir = ((& git -C $Path rev-parse --git-common-dir 2>$null) | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($commonDir)) {
            return $false
        }
    } finally {
        $ErrorActionPreference = $previousEap
    }

    $resolvedGitDir = if ([System.IO.Path]::IsPathRooted($gitDir)) {
        ConvertTo-NormalizedDevSpacePath $gitDir
    } else {
        ConvertTo-NormalizedDevSpacePath (Join-Path $Path $gitDir)
    }
    $resolvedCommonDir = if ([System.IO.Path]::IsPathRooted($commonDir)) {
        ConvertTo-NormalizedDevSpacePath $commonDir
    } else {
        ConvertTo-NormalizedDevSpacePath (Join-Path $Path $commonDir)
    }
    return -not [System.StringComparer]::Ordinal.Equals($resolvedGitDir, $resolvedCommonDir)
}

function Get-DevSpaceHealDecision {
    param(
        [Parameter(Mandatory = $true)][bool]$LocalHealthy,
        [Parameter(Mandatory = $true)][bool]$WorkerHealthy,
        [Parameter(Mandatory = $true)][bool]$QuickTunnelAlive,
        [switch]$ForceReregister
    )

    if (-not $LocalHealthy) {
        return [pscustomobject]@{
            Action                  = "staged-recycle"
            PreserveNode            = $false
            PreserveActiveDist      = $false
            PreserveTunnelHostname  = $false
        }
    }

    if ($ForceReregister) {
        if ($QuickTunnelAlive) {
            return [pscustomobject]@{
                Action                  = "reregister"
                PreserveNode            = $true
                PreserveActiveDist      = $true
                PreserveTunnelHostname  = $true
            }
        }
        return [pscustomobject]@{
            Action                  = "restart-tunnel"
            PreserveNode            = $true
            PreserveActiveDist      = $true
            PreserveTunnelHostname  = $false
        }
    }

    if ($WorkerHealthy) {
        return [pscustomobject]@{
            Action                  = "noop"
            PreserveNode            = $true
            PreserveActiveDist      = $true
            PreserveTunnelHostname  = $true
        }
    }

    if ($QuickTunnelAlive) {
        return [pscustomobject]@{
            Action                  = "reregister"
            PreserveNode            = $true
            PreserveActiveDist      = $true
            PreserveTunnelHostname  = $true
        }
    }

    return [pscustomobject]@{
        Action                  = "restart-tunnel"
        PreserveNode            = $true
        PreserveActiveDist      = $true
        PreserveTunnelHostname  = $false
    }
}

function Get-DevSpaceFailureDisposition {
    param(
        [switch]$IntentionalStop,
        [Parameter(Mandatory = $true)][bool]$LocalHealthy
    )

    if ($IntentionalStop) {
        return [pscustomobject]@{
            LeaveRunning    = $false
            ExitCode        = 0
            PreserveOrigin  = $false
        }
    }
    if ($LocalHealthy) {
        return [pscustomobject]@{
            LeaveRunning    = $true
            ExitCode        = 1
            PreserveOrigin  = $true
        }
    }
    return [pscustomobject]@{
        LeaveRunning    = $false
        ExitCode        = 1
        PreserveOrigin  = $false
    }
}

function Get-DevSpaceDistFingerprint {
    param([string]$CliPath)

    if ([string]::IsNullOrWhiteSpace($CliPath) -or -not (Test-Path -LiteralPath $CliPath -PathType Leaf)) {
        return $null
    }
    return (Get-FileHash -LiteralPath $CliPath -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Copy-DevSpaceDistSnapshot {
    param(
        [Parameter(Mandatory = $true)][string]$DistDirectory,
        [Parameter(Mandatory = $true)][string]$SnapshotDirectory
    )

    if (-not (Test-Path -LiteralPath $DistDirectory -PathType Container)) {
        return $false
    }
    if (Test-Path -LiteralPath $SnapshotDirectory) {
        Remove-Item -LiteralPath $SnapshotDirectory -Recurse -Force
    }
    $parent = Split-Path -Parent $SnapshotDirectory
    if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    Copy-Item -LiteralPath $DistDirectory -Destination $SnapshotDirectory -Recurse -Force
    return $true
}

function Restore-DevSpaceDistSnapshot {
    param(
        [Parameter(Mandatory = $true)][string]$DistDirectory,
        [Parameter(Mandatory = $true)][string]$SnapshotDirectory
    )

    if (-not (Test-Path -LiteralPath $SnapshotDirectory -PathType Container)) {
        return $false
    }
    if (Test-Path -LiteralPath $DistDirectory) {
        Remove-Item -LiteralPath $DistDirectory -Recurse -Force
    }
    Copy-Item -LiteralPath $SnapshotDirectory -Destination $DistDirectory -Recurse -Force
    return $true
}

function Get-DevSpaceQuickTunnelUrlFromLogText {
    param([string]$LogText)

    if ([string]::IsNullOrWhiteSpace($LogText)) {
        return $null
    }
    $urlMatches = [regex]::Matches($LogText, "https://[a-zA-Z0-9\-]+\.trycloudflare\.com")
    if ($urlMatches.Count -eq 0) {
        return $null
    }
    return $urlMatches[$urlMatches.Count - 1].Value
}

function Test-DevSpaceProcessAliveById {
    param([int]$ProcessId)

    if ($ProcessId -le 0) {
        return $false
    }
    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    return ($null -ne $process)
}

function Get-DevSpacePreferredSourcePinPath {
    return (Join-Path $env:USERPROFILE ".devspace\preferred-runtime-source.json")
}

function Read-DevSpacePreferredSourcePin {
    param([Parameter(Mandatory = $true)][string]$PinPath)

    if (-not (Test-Path -LiteralPath $PinPath -PathType Leaf)) {
        return $null
    }
    try {
        return Get-Content -LiteralPath $PinPath -Raw | ConvertFrom-Json
    } catch {
        throw "Preferred runtime source pin is unreadable: $PinPath"
    }
}

function Save-DevSpacePreferredRuntimeSource {
    param(
        [Parameter(Mandatory = $true)][string]$PinPath,
        [Parameter(Mandatory = $true)][string]$Repository,
        [string]$PinnedBy = "setup_devspace.ps1 -PinPreferredSource",
        [bool]$RequireClean = $true
    )

    if (-not (Test-Path -LiteralPath $Repository)) {
        throw "Cannot pin missing repository: $Repository"
    }
    if (Test-DevSpaceGitWorktreePath $Repository) {
        throw "Refusing to pin a Git worktree as the production runtime source: $Repository"
    }

    $commit = $null
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $commit = ((& git -C $Repository rev-parse HEAD 2>$null) | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) {
            $commit = $null
        }
    } finally {
        $ErrorActionPreference = $previousEap
    }

    $directory = Split-Path -Parent $PinPath
    if (-not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }

    $record = [ordered]@{
        repository     = (Resolve-Path -LiteralPath $Repository).Path
        requireClean   = [bool]$RequireClean
        pinnedAt       = (Get-Date).ToString("o")
        pinnedBy       = $PinnedBy
        expectedCommit = $commit
        note           = "Production setup must run from this canonical checkout, never from a Git worktree."
    }
    $temporaryFile = "$PinPath.tmp-$PID-$([Guid]::NewGuid().ToString('N'))"
    try {
        ($record | ConvertTo-Json -Depth 4) | Set-Content -LiteralPath $temporaryFile -Encoding UTF8
        Move-Item -LiteralPath $temporaryFile -Destination $PinPath -Force
    } finally {
        Remove-Item -LiteralPath $temporaryFile -Force -ErrorAction SilentlyContinue
    }
}

function Assert-DevSpacePreferredRuntimeSource {
    param(
        [Parameter(Mandatory = $true)][string]$ApprovedCheckout,
        [Parameter(Mandatory = $true)][string]$PinPath,
        [switch]$OverridePreferredSource
    )

    if (-not (Test-Path -LiteralPath $ApprovedCheckout)) {
        throw "Approved canonical checkout is missing: $ApprovedCheckout"
    }
    if (Test-DevSpaceGitWorktreePath $ApprovedCheckout) {
        throw "Approved canonical checkout is a Git worktree; refusing production setup: $ApprovedCheckout"
    }
    if (-not (Test-Path -LiteralPath $PinPath -PathType Leaf)) {
        throw "Preferred runtime source pin is missing ($PinPath). Pin the canonical checkout with: powershell -ExecutionPolicy Bypass -File E:\Code\devspace\setup_devspace.ps1 -PinPreferredSource"
    }

    $pin = Read-DevSpacePreferredSourcePin -PinPath $PinPath
    $pinRepo = [string]$pin.repository
    if ([string]::IsNullOrWhiteSpace($pinRepo)) {
        throw "Preferred runtime source pin does not name a repository: $PinPath"
    }
    if (-not (Test-Path -LiteralPath $pinRepo)) {
        throw "Pinned runtime source is missing: $pinRepo"
    }
    if (Test-DevSpaceGitWorktreePath $pinRepo) {
        throw "Pinned runtime source is a Git worktree; refusing production setup: $pinRepo"
    }

    $approvedNorm = ConvertTo-NormalizedDevSpacePath $ApprovedCheckout
    $pinNorm = ConvertTo-NormalizedDevSpacePath $pinRepo
    if (-not [System.StringComparer]::Ordinal.Equals($approvedNorm, $pinNorm)) {
        if (-not $OverridePreferredSource) {
            throw "Pinned runtime source '$pinRepo' does not match approved checkout '$ApprovedCheckout'."
        }
    }
    return $pin
}

function Assert-DevSpaceSourceCleanForRecycle {
    param(
        [Parameter(Mandatory = $true)][string]$Repository,
        [switch]$AllowDirty,
        $Pin
    )

    if ($AllowDirty) {
        return
    }
    $requireClean = $true
    if ($null -ne $Pin -and $null -ne $Pin.PSObject.Properties['requireClean']) {
        $requireClean = [bool]$Pin.requireClean
    }
    if (-not $requireClean) {
        return
    }
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $statusLines = @(& git -C $Repository status --porcelain=v1 --untracked-files=all 2>$null)
        if ($LASTEXITCODE -ne 0) {
            throw "Could not inspect Git dirty state for recycle of '$Repository'."
        }
    } finally {
        $ErrorActionPreference = $previousEap
    }
    if ($statusLines.Count -gt 0) {
        throw "Pinned runtime source is dirty; refuse staged recycle without -AllowDirty: $Repository"
    }
}

function Enter-DevSpaceSetupLock {
    param(
        [Parameter(Mandatory = $true)][string]$LockPath,
        [int]$WaitSeconds = 60,
        [int]$HolderPid = $PID
    )

    $directory = Split-Path -Parent $LockPath
    if (-not [string]::IsNullOrWhiteSpace($directory) -and -not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }

    $deadline = (Get-Date).AddSeconds([Math]::Max(0, $WaitSeconds))
    while ($true) {
        $stale = $false
        if (Test-Path -LiteralPath $LockPath -PathType Leaf) {
            $existing = $null
            try {
                $existing = Get-Content -LiteralPath $LockPath -Raw | ConvertFrom-Json
            } catch {
                $stale = $true
            }
            if (-not $stale -and $null -ne $existing -and $existing.pid) {
                if (Test-DevSpaceProcessAliveById ([int]$existing.pid)) {
                    if ((Get-Date) -ge $deadline) {
                        throw "Another DevSpace setup holds the exclusive lock (PID=$($existing.pid)). Refusing a second mutator."
                    }
                    Start-Sleep -Seconds 1
                    continue
                }
                $stale = $true
            } elseif (-not $stale) {
                $stale = $true
            }
            if ($stale) {
                Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
            }
        }

        try {
            $stream = [System.IO.File]::Open($LockPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
            try {
                $record = @{
                    pid       = $HolderPid
                    startedAt = (Get-Date).ToString("o")
                    host      = $env:COMPUTERNAME
                } | ConvertTo-Json -Compress
                $bytes = [System.Text.Encoding]::UTF8.GetBytes($record)
                $stream.Write($bytes, 0, $bytes.Length)
            } finally {
                $stream.Dispose()
            }
            return [pscustomobject]@{ LockPath = $LockPath; Pid = $HolderPid }
        } catch {
            if ((Get-Date) -ge $deadline) {
                throw "Could not acquire DevSpace setup lock at '$LockPath'."
            }
            Start-Sleep -Milliseconds 200
        }
    }
}

function Exit-DevSpaceSetupLock {
    param(
        [Parameter(Mandatory = $true)][string]$LockPath,
        [int]$HolderPid = $PID
    )

    if (-not (Test-Path -LiteralPath $LockPath -PathType Leaf)) {
        return
    }
    try {
        $existing = Get-Content -LiteralPath $LockPath -Raw | ConvertFrom-Json
        if ($null -ne $existing -and [int]$existing.pid -eq $HolderPid) {
            Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
        }
    } catch {
        Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
    }
}
