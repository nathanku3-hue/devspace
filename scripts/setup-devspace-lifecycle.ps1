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

function Resolve-DevSpaceChatSessionProvider {
    param(
        $ExistingConfig,
        [string]$EnvironmentValue
    )

    $candidate = $EnvironmentValue
    if ([string]::IsNullOrWhiteSpace($candidate) -and $null -ne $ExistingConfig) {
        $property = $ExistingConfig.PSObject.Properties['chatSessionProvider']
        if ($null -ne $property) {
            $candidate = [string]$property.Value
        }
    }
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        $candidate = "chatgpt"
    }
    $candidate = $candidate.Trim().ToLowerInvariant()
    if ($candidate -notin @("chatgpt", "chatshare")) {
        throw "Invalid DevSpace chat session provider '$candidate'. Expected chatgpt or chatshare."
    }
    return $candidate
}

function New-DevSpaceServerConfig {
    param(
        $ExistingConfig,
        [Parameter(Mandatory = $true)][string]$HostName,
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string[]]$AllowedRoots,
        [Parameter(Mandatory = $true)][string]$PublicBaseUrl,
        [Parameter(Mandatory = $true)][string[]]$AllowedHosts,
        [Parameter(Mandatory = $true)][string]$ChatSessionProvider
    )

    $merged = [ordered]@{}
    if ($null -ne $ExistingConfig) {
        if ($ExistingConfig -is [System.Collections.IDictionary]) {
            foreach ($key in $ExistingConfig.Keys) {
                $merged[[string]$key] = $ExistingConfig[$key]
            }
        } else {
            foreach ($property in $ExistingConfig.PSObject.Properties) {
                $merged[$property.Name] = $property.Value
            }
        }
    }

    $merged["host"] = $HostName
    $merged["port"] = $Port
    $merged["allowedRoots"] = @($AllowedRoots)
    $merged["publicBaseUrl"] = $PublicBaseUrl
    $merged["allowedHosts"] = @($AllowedHosts)
    $merged["chatSessionProvider"] = $ChatSessionProvider
    return $merged
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

function Test-DevSpaceCloudflareUpstreamFailure {
    param(
        [string]$Body,
        [int]$StatusCode = 0
    )

    if ($StatusCode -in @(502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530)) {
        return $true
    }
    $text = [string]$Body
    if ([string]::IsNullOrWhiteSpace($text)) {
        return $false
    }
    if ($text -match '(?i)error code:\s*(1016|1033)') {
        return $true
    }
    if ($text -match '(?i)upstream error') {
        return $true
    }
    if ($text -match '(?i)Origin DNS error') {
        return $true
    }
    if ($text -match '(?i)Cloudflare Tunnel error') {
        return $true
    }
    return $false
}

function Test-DevSpaceDiscoveryBodyOk {
    param([string]$Body)

    if ([string]::IsNullOrWhiteSpace($Body)) {
        return $false
    }
    if (Test-DevSpaceCloudflareUpstreamFailure -Body $Body) {
        return $false
    }
    $trimmed = $Body.Trim()
    if ($trimmed.StartsWith("<")) {
        return $false
    }
    if (-not $trimmed.StartsWith("{")) {
        return $false
    }
    try {
        $null = $trimmed | ConvertFrom-Json
    } catch {
        return $false
    }
    return $true
}

function Test-DevSpaceDiscoveryDocument {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Body,
        [Parameter(Mandatory = $true)][string]$PublicBaseUrl
    )

    if (-not (Test-DevSpaceDiscoveryBodyOk -Body $Body)) {
        return $false
    }
    try {
        $document = $Body.Trim() | ConvertFrom-Json
    } catch {
        return $false
    }

    $base = $PublicBaseUrl.TrimEnd('/')
    $ordinal = [System.StringComparer]::OrdinalIgnoreCase
    switch ($Path) {
        "/.well-known/oauth-protected-resource/mcp" {
            if (-not $ordinal.Equals(([string]$document.resource).TrimEnd('/'), "$base/mcp")) {
                return $false
            }
            $authorizationServers = @($document.authorization_servers | ForEach-Object { ([string]$_).TrimEnd('/') })
            return (@($authorizationServers | Where-Object { $ordinal.Equals($_, $base) }).Count -gt 0)
        }
        "/.well-known/oauth-authorization-server" {
            if (-not $ordinal.Equals(([string]$document.issuer).TrimEnd('/'), $base)) { return $false }
            if (-not $ordinal.Equals([string]$document.authorization_endpoint, "$base/authorize")) { return $false }
            if (-not $ordinal.Equals([string]$document.token_endpoint, "$base/token")) { return $false }
            if (-not $ordinal.Equals([string]$document.registration_endpoint, "$base/register")) { return $false }
            return $true
        }
        "/.well-known/openid-configuration" {
            if (-not $ordinal.Equals(([string]$document.issuer).TrimEnd('/'), $base)) { return $false }
            if (-not $ordinal.Equals([string]$document.authorization_endpoint, "$base/authorize")) { return $false }
            if (-not $ordinal.Equals([string]$document.token_endpoint, "$base/token")) { return $false }
            if (-not $ordinal.Equals([string]$document.registration_endpoint, "$base/register")) { return $false }
            return $true
        }
        default {
            return $false
        }
    }
}

function Test-DevSpacePublicMcpReachedOrigin {
    param(
        [string]$Body,
        [int]$StatusCode
    )

    if (Test-DevSpaceCloudflareUpstreamFailure -Body $Body -StatusCode $StatusCode) {
        return $false
    }
    # Any 401 from the Worker means origin OAuth answered. Do not require a
    # specific JSON body; SYSTEM curl may omit or truncate it.
    if ($StatusCode -eq 401) {
        return $true
    }
    if ($StatusCode -eq 200 -and -not [string]::IsNullOrWhiteSpace($Body) -and $Body.Trim().StartsWith("{")) {
        return $true
    }
    return $false
}

function Get-DevSpacePublicMcpProbeKind {
    param(
        [string]$Body,
        [int]$StatusCode
    )

    if (Test-DevSpacePublicMcpReachedOrigin -Body $Body -StatusCode $StatusCode) {
        return "reached"
    }
    if (Test-DevSpaceCloudflareUpstreamFailure -Body $Body -StatusCode $StatusCode) {
        return "upstream-failure"
    }
    return "unknown"
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
        [switch]$ForceReregister,
        [switch]$ForceRecycle
    )

    if ($ForceRecycle) {
        return [pscustomobject]@{
            Action                  = "staged-recycle"
            PreserveNode            = $false
            PreserveActiveDist      = $false
            PreserveTunnelHostname  = $false
        }
    }

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

function Get-DevSpacePublicPathHealDecision {
    param(
        [Parameter(Mandatory = $true)][bool]$LocalHealthy,
        [bool]$PublicMcpReachedOrigin,
        [string]$PublicMcpKind,
        [Parameter(Mandatory = $true)][bool]$QuickTunnelAlive,
        [datetime]$LastTunnelRestartUtc,
        [datetime]$NowUtc,
        [int]$TunnelRestartCooldownSec = 300
    )

    if ($null -eq $NowUtc -or $NowUtc -eq [datetime]::MinValue) {
        $NowUtc = [datetime]::UtcNow
    } else {
        $NowUtc = $NowUtc.ToUniversalTime()
    }

    $kind = [string]$PublicMcpKind
    if ([string]::IsNullOrWhiteSpace($kind)) {
        $kind = if ($PublicMcpReachedOrigin) { "reached" } else { "upstream-failure" }
    }

    if (-not $LocalHealthy) {
        return [pscustomobject]@{
            Action       = "reboot-origin"
            PreserveNode = $false
            Reason       = "local origin /healthz is down; reboot origin only"
        }
    }

    if ($kind -eq "reached") {
        return [pscustomobject]@{
            Action       = "noop"
            PreserveNode = $true
            Reason       = "POST /mcp reached origin; 502 is not an origin fault"
        }
    }

    if ($kind -eq "unknown") {
        return [pscustomobject]@{
            Action       = "noop"
            PreserveNode = $true
            Reason       = "POST /mcp probe inconclusive; do not treat timeout/parse failure as 502"
        }
    }

    $cooldownActive = $false
    if ($null -ne $LastTunnelRestartUtc -and $LastTunnelRestartUtc -gt [datetime]::MinValue) {
        $cooldownActive = ($NowUtc - $LastTunnelRestartUtc.ToUniversalTime()).TotalSeconds -lt $TunnelRestartCooldownSec
    }

    if (-not $QuickTunnelAlive) {
        return [pscustomobject]@{
            Action       = "restart-tunnel"
            PreserveNode = $true
            Reason       = "public 502/530 and cloudflared is down; remint tunnel, do not reboot origin"
        }
    }

    if ($cooldownActive) {
        return [pscustomobject]@{
            Action       = "reregister"
            PreserveNode = $true
            Reason       = "public 502/530 during trycloudflare warmup; reregister only"
        }
    }

    return [pscustomobject]@{
        Action       = "restart-tunnel"
        PreserveNode = $true
        Reason       = "public 502/530 with live cloudflared; remint tunnel, do not reboot origin"
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

function Get-DevSpaceKnownCloudflaredLogFiles {
    param(
        [string]$RuntimeFile,
        [string]$ScriptLogFile,
        [string]$SupervisorConfigPath,
        [string]$CommandLineLogFile
    )

    $candidates = New-Object 'System.Collections.Generic.List[string]'
    if (-not [string]::IsNullOrWhiteSpace($CommandLineLogFile)) {
        $candidates.Add($CommandLineLogFile)
    }
    $useDefaultSupervisorSources = [string]::IsNullOrWhiteSpace($SupervisorConfigPath)
    if ($useDefaultSupervisorSources) {
        $SupervisorConfigPath = Join-Path $env:ProgramData "DevSpace\supervisor.json"
    }
    if (Test-Path -LiteralPath $SupervisorConfigPath -PathType Leaf) {
        try {
            $supervisor = Get-Content -LiteralPath $SupervisorConfigPath -Raw | ConvertFrom-Json
            if (-not [string]::IsNullOrWhiteSpace([string]$supervisor.quickTunnelStderrLog)) {
                $candidates.Add([string]$supervisor.quickTunnelStderrLog)
            }
            if (-not [string]::IsNullOrWhiteSpace([string]$supervisor.quickTunnelStdoutLog)) {
                $candidates.Add([string]$supervisor.quickTunnelStdoutLog)
            }
        } catch {
        }
    }
    if ($useDefaultSupervisorSources) {
        $candidates.Add((Join-Path $env:ProgramData "DevSpace\logs\quick-tunnel-stderr.log"))
        $candidates.Add((Join-Path $env:ProgramData "DevSpace\logs\quick-tunnel-stdout.log"))
    }
    if (-not [string]::IsNullOrWhiteSpace($RuntimeFile) -and (Test-Path -LiteralPath $RuntimeFile -PathType Leaf)) {
        try {
            $state = Get-Content -LiteralPath $RuntimeFile -Raw | ConvertFrom-Json
            if (-not [string]::IsNullOrWhiteSpace([string]$state.cloudflaredLog)) {
                $candidates.Add([string]$state.cloudflaredLog)
            }
        } catch {
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($ScriptLogFile)) {
        $candidates.Add($ScriptLogFile)
    }

    $paths = New-Object 'System.Collections.Generic.List[string]'
    foreach ($candidate in $candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) {
            continue
        }
        $full = $null
        try {
            $full = [System.IO.Path]::GetFullPath($candidate)
        } catch {
            continue
        }
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
            continue
        }
        $duplicate = $false
        foreach ($existing in $paths) {
            if ([System.StringComparer]::OrdinalIgnoreCase.Equals($existing, $full)) {
                $duplicate = $true
                break
            }
        }
        if (-not $duplicate) {
            $paths.Add($full)
        }
    }
    return @($paths)
}

function Get-DevSpaceQuickTunnelUrlCandidatesFromLogFiles {
    param([string[]]$LogFiles)

    $ranked = @(
        @($LogFiles) |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and (Test-Path -LiteralPath $_ -PathType Leaf) } |
            ForEach-Object { Get-Item -LiteralPath $_ } |
            Sort-Object LastWriteTimeUtc -Descending
    )
    $seenUrls = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    $candidates = @()
    foreach ($file in $ranked) {
        $text = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction SilentlyContinue
        $url = Get-DevSpaceQuickTunnelUrlFromLogText $text
        if ([string]::IsNullOrWhiteSpace($url) -or -not $seenUrls.Add($url)) {
            continue
        }
        $candidates += [pscustomobject]@{
            TunnelUrl       = $url
            LogFile         = $file.FullName
            LastWriteTimeUtc = $file.LastWriteTimeUtc
        }
    }
    return @($candidates)
}

function Get-DevSpaceQuickTunnelUrlFromLogFiles {
    param([string[]]$LogFiles)

    $candidates = @(Get-DevSpaceQuickTunnelUrlCandidatesFromLogFiles -LogFiles $LogFiles)
    if ($candidates.Count -eq 0) {
        return $null
    }
    return $candidates[0]
}

function Get-DevSpaceProxyHealthObservation {
    param(
        [string]$Body,
        [Parameter(Mandatory = $true)][string]$ExpectedTunnelHost
    )

    if (Test-DevSpaceHealthzJson $Body) {
        return [pscustomobject]@{
            Kind     = "healthy"
            SeenHost = $null
            Title    = $null
        }
    }

    $titleMatch = [regex]::Match([string]$Body, "(?is)<title>\s*(.*?)\s*</title>")
    $hostMatch = [regex]::Match([string]$Body, "(?i)([a-z0-9-]+\.trycloudflare\.com)")
    $title = if ($titleMatch.Success) { $titleMatch.Groups[1].Value.Trim() } else { $null }
    $seenHost = if ($hostMatch.Success) { $hostMatch.Groups[1].Value } else { $null }

    $invalidHostMatch = [regex]::Match([string]$Body, "(?i)Invalid Host:\s*([a-z0-9.-]+)")
    if ($invalidHostMatch.Success) {
        return [pscustomobject]@{
            Kind     = "invalid-host"
            SeenHost = $invalidHostMatch.Groups[1].Value
            Title    = $title
        }
    }

    if (Test-DevSpaceCloudflareUpstreamFailure -Body $Body) {
        if (-not [string]::IsNullOrWhiteSpace($seenHost) -and
            -not [System.StringComparer]::OrdinalIgnoreCase.Equals($seenHost, $ExpectedTunnelHost)) {
            return [pscustomobject]@{
                Kind     = "stale-upstream"
                SeenHost = $seenHost
                Title    = $title
            }
        }
        return [pscustomobject]@{
            Kind     = "expected-upstream-not-ready"
            SeenHost = $seenHost
            Title    = $title
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($seenHost)) {
        if ([System.StringComparer]::OrdinalIgnoreCase.Equals($seenHost, $ExpectedTunnelHost)) {
            return [pscustomobject]@{
                Kind     = "expected-upstream-not-ready"
                SeenHost = $seenHost
                Title    = $title
            }
        }
        return [pscustomobject]@{
            Kind     = "stale-upstream"
            SeenHost = $seenHost
            Title    = $title
        }
    }

    return [pscustomobject]@{
        Kind     = if ($titleMatch.Success) { "cloudflare-error" } else { "not-ready" }
        SeenHost = $null
        Title    = $title
    }
}

function Get-DevSpaceCloudflaredLogFileFromCommandLine {
    param([string]$CommandLine)

    if ([string]::IsNullOrWhiteSpace($CommandLine)) {
        return $null
    }
    $match = [regex]::Match($CommandLine, '(?i)(?:^|\s)--logfile(?:=|\s+)(?:"([^"]+)"|(\S+))')
    if (-not $match.Success) {
        return $null
    }
    if (-not [string]::IsNullOrWhiteSpace($match.Groups[1].Value)) {
        return $match.Groups[1].Value
    }
    return $match.Groups[2].Value
}

function Update-DevSpaceTunnelCustodyFile {
    param(
        [Parameter(Mandatory = $true)][string]$RuntimeFile,
        [Parameter(Mandatory = $true)][string]$TunnelUrl,
        [Parameter(Mandatory = $true)][string]$TunnelHost,
        [Parameter(Mandatory = $true)][int]$CloudflaredPid,
        [string]$CloudflaredLog,
        [int]$DevSpacePid = -1,
        [string]$PublicBaseUrl
    )

    $state = $null
    if (Test-Path -LiteralPath $RuntimeFile -PathType Leaf) {
        try {
            $state = Get-Content -LiteralPath $RuntimeFile -Raw | ConvertFrom-Json
        } catch {
            throw "Cannot update quick-tunnel custody because runtime state is unreadable: $RuntimeFile. $($_.Exception.Message)"
        }
    }
    if ($null -eq $state) {
        $state = [pscustomobject]@{}
    }

    $updates = [ordered]@{
        tunnelUrl         = $TunnelUrl
        tunnelHost        = $TunnelHost
        cloudflaredPid    = $CloudflaredPid
        cloudflaredLog    = $CloudflaredLog
        tunnelPublishedAt = (Get-Date).ToString("o")
    }
    if ($DevSpacePid -ge 0) {
        $updates.devspacePid = $DevSpacePid
    }
    if (-not [string]::IsNullOrWhiteSpace($PublicBaseUrl)) {
        $updates.publicBaseUrl = $PublicBaseUrl
    }

    foreach ($entry in $updates.GetEnumerator()) {
        $property = $state.PSObject.Properties[$entry.Key]
        if ($null -eq $property) {
            $state | Add-Member -MemberType NoteProperty -Name $entry.Key -Value $entry.Value
        } else {
            $property.Value = $entry.Value
        }
    }

    $directory = Split-Path -Parent $RuntimeFile
    if (-not [string]::IsNullOrWhiteSpace($directory) -and -not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    $temporaryFile = "$RuntimeFile.tmp-$PID-$([Guid]::NewGuid().ToString('N'))"
    try {
        ($state | ConvertTo-Json -Depth 12) | Set-Content -LiteralPath $temporaryFile -Encoding UTF8
        Move-Item -LiteralPath $temporaryFile -Destination $RuntimeFile -Force
    } finally {
        Remove-Item -LiteralPath $temporaryFile -Force -ErrorAction SilentlyContinue
    }
    return $state
}

function Get-DevSpaceCloudflaredLaunchCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string]$LocalHost,
        [Parameter(Mandatory = $true)][int]$LocalPort,
        [Parameter(Mandatory = $true)][string]$LogFile
    )

    return '"{0}" tunnel --url http://{1}:{2} --protocol http2 --edge-ip-version 4 --no-autoupdate --loglevel info --logfile "{3}"' -f $Executable, $LocalHost, $LocalPort, $LogFile
}

function Get-DevSpaceProcessRecordByPid {
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [string]$ExpectedName = ""
    )

    if ($ProcessId -le 0) {
        return $null
    }
    $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $proc) {
        return $null
    }
    $actualName = $proc.ProcessName + ".exe"
    if (-not [string]::IsNullOrWhiteSpace($ExpectedName)) {
        if (-not [System.StringComparer]::OrdinalIgnoreCase.Equals($actualName, $ExpectedName)) {
            return $null
        }
    }
    return [pscustomobject]@{
        Name        = $actualName
        ProcessId   = $proc.Id
        CommandLine = ""
    }
}

function Test-DevSpaceOriginRecord {
    param(
        [Parameter(Mandatory = $true)]$Record,
        [int]$ListenerPid = 0,
        [int]$RememberedPid = 0
    )

    if ($null -eq $Record) {
        return $false
    }
    if (-not [System.StringComparer]::OrdinalIgnoreCase.Equals([string]$Record.Name, "node.exe")) {
        return $false
    }
    $cmd = [string]$Record.CommandLine
    if (
        -not [string]::IsNullOrWhiteSpace($cmd) -and
        $cmd -match 'devspace-src[\\/]+dist[\\/]+cli\.js' -and
        $cmd -match 'serve'
    ) {
        return $true
    }
    $processId = [int]$Record.ProcessId
    if ($ListenerPid -gt 0 -and $processId -eq $ListenerPid) {
        return $true
    }
    if ($RememberedPid -gt 0 -and $processId -eq $RememberedPid) {
        return $true
    }
    return $false
}

function Test-DevSpaceCloudflaredRecord {
    param(
        [Parameter(Mandatory = $true)]$Record,
        [Parameter(Mandatory = $true)][int]$LocalPort,
        [int]$RememberedPid = 0
    )

    if ($null -eq $Record) {
        return $false
    }
    $name = [string]$Record.Name
    if (-not [System.StringComparer]::OrdinalIgnoreCase.Equals($name, "cloudflared.exe")) {
        return $false
    }
    $line = [string]$Record.CommandLine
    $portMarker = "127.0.0.1:$LocalPort"
    if (-not [string]::IsNullOrWhiteSpace($line) -and $line.Contains($portMarker)) {
        return $true
    }
    if ($RememberedPid -gt 0 -and [int]$Record.ProcessId -eq $RememberedPid) {
        return $true
    }
    # A scrubbed command line is not sufficient ownership evidence by itself.
    # Only the remembered PID may match without a visible DevSpace port marker.
    return $false
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
        # Staged recycle only runs when local /healthz is already down.
        # Blocking restore of a dead origin because the pinned checkout is dirty
        # recreates the 502: catch/finally stops leftovers and the Worker keeps a dead tunnel.
        Write-Warning "Pinned runtime source is dirty; continuing staged recycle of a down origin from $Repository. Pass -AllowDirty to silence this warning."
        return
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
