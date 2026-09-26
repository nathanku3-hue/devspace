# Machine supervisor for the production DevSpace origin.
# The elevated installer copies this file to %ProgramData%\DevSpace and the
# SYSTEM task executes only that machine-owned copy. It never runs setup or npm.
[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path $env:ProgramData "DevSpace\supervisor.json"),
    [switch]$LibraryOnly
)

$ErrorActionPreference = "Stop"
$script:SupervisorLogPath = $null

function Write-DevSpaceSupervisorLog {
    param([string]$Message, [string]$Level = "INFO")

    $line = "{0} [{1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level, $Message
    if (-not [string]::IsNullOrWhiteSpace($script:SupervisorLogPath)) {
        try { Add-Content -LiteralPath $script:SupervisorLogPath -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue } catch {}
    }
}

function Test-DevSpaceSupervisorHealthz {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [int]$TimeoutSec = 3
    )

    try {
        $body = & curl.exe -s --noproxy "*" --max-time $TimeoutSec $Url 2>$null
        if ([string]::IsNullOrWhiteSpace($body)) { return $false }
        $parsed = $body | ConvertFrom-Json
        return ($parsed.ok -eq $true -and [string]$parsed.name -eq "devspace")
    } catch {
        return $false
    }
}

function Test-DevSpaceSupervisorLocalStable {
    param(
        [Parameter(Mandatory = $true)][pscustomobject]$Config,
        [int]$Attempts = 3
    )

    $url = "http://$($Config.localHost):$($Config.localPort)/healthz"
    for ($i = 0; $i -lt $Attempts; $i++) {
        if (Test-DevSpaceSupervisorHealthz -Url $url) { return $true }
        if ($i + 1 -lt $Attempts) { Start-Sleep -Seconds 1 }
    }
    return $false
}

function Test-DevSpaceSupervisorCloudflareUpstreamFailure {
    param(
        [string]$Body,
        [int]$StatusCode = 0
    )

    if ($StatusCode -eq 530) { return $true }
    $text = [string]$Body
    if ([string]::IsNullOrWhiteSpace($text)) { return $false }
    if ($text -match '(?i)error code:\s*(1016|1033)') { return $true }
    if ($text -match '(?i)upstream error') { return $true }
    if ($text -match '(?i)Origin DNS error') { return $true }
    if ($text -match '(?i)Cloudflare Tunnel error') { return $true }
    if ($StatusCode -eq 502 -and ($text.Trim().StartsWith("<") -or $text -match '(?i)Bad Gateway')) { return $true }
    return $false
}

function Get-DevSpaceSupervisorPublicMcpProbe {
    param(
        [Parameter(Mandatory = $true)][pscustomobject]$Config,
        [int]$TimeoutSec = 15
    )

    $url = "$($Config.publicProxyBase.TrimEnd('/'))/mcp"
    $bodyFile = [System.IO.Path]::GetTempFileName()
    $curl = Join-Path $env:SystemRoot "System32\curl.exe"
    if (!(Test-Path -LiteralPath $curl)) { $curl = "curl.exe" }
    try {
        $raw = & $curl -s -4 --noproxy "*" --max-time $TimeoutSec -o $bodyFile -w "%{http_code}" `
            -X POST $url `
            -H "Accept: application/json, text/event-stream" `
            -H "Content-Type: application/json" `
            --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"devspace-supervisor","version":"1.0.0"}}}' 2>&1
        $codeText = (($raw | Out-String).Trim() -split '\r?\n' | Select-Object -Last 1).Trim()
        $status = 0
        [void][int]::TryParse($codeText, [ref]$status)
        $body = ""
        if (Test-Path -LiteralPath $bodyFile) {
            $body = [string](Get-Content -LiteralPath $bodyFile -Raw -ErrorAction SilentlyContinue)
        }
        $upstream = Test-DevSpaceSupervisorCloudflareUpstreamFailure -Body $body -StatusCode $status
        $reached = (-not $upstream -and ($status -eq 401 -or ($status -eq 200 -and $body.Trim().StartsWith("{"))))
        $kind = if ($reached) { "reached" } elseif ($upstream) { "upstream-failure" } else { "unknown" }
        $preview = if ([string]::IsNullOrWhiteSpace($body)) { "" } elseif ($body.Length -gt 120) { $body.Substring(0, 120) } else { $body }
        return [pscustomobject]@{
            Kind       = $kind
            StatusCode = $status
            Body       = $body
            Preview    = $preview
            ReachedOrigin = $reached
        }
    } catch {
        Write-DevSpaceSupervisorLog "Public POST /mcp probe failed: $($_.Exception.Message)" "WARN"
        return [pscustomobject]@{
            Kind          = "unknown"
            StatusCode    = 0
            Body          = $_.Exception.Message
            Preview       = $_.Exception.Message
            ReachedOrigin = $false
        }
    } finally {
        Remove-Item -LiteralPath $bodyFile -Force -ErrorAction SilentlyContinue
    }
}

function Test-DevSpaceSupervisorPublicMcpReachedOrigin {
    param(
        [Parameter(Mandatory = $true)][pscustomobject]$Config,
        [int]$TimeoutSec = 15
    )

    $probe = Get-DevSpaceSupervisorPublicMcpProbe -Config $Config -TimeoutSec $TimeoutSec
    return [bool]$probe.ReachedOrigin
}

function Get-DevSpaceSupervisorHealStatePath {
    param([Parameter(Mandatory = $true)][pscustomobject]$Config)

    return (Join-Path (Split-Path -Parent $Config.supervisorLogPath) "supervisor-heal.json")
}

function Read-DevSpaceSupervisorHealState {
    param([Parameter(Mandatory = $true)][pscustomobject]$Config)

    $path = Get-DevSpaceSupervisorHealStatePath -Config $Config
    if (!(Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    try { return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json } catch { return $null }
}

function Write-DevSpaceSupervisorHealState {
    param(
        [Parameter(Mandatory = $true)][pscustomobject]$Config,
        [Parameter(Mandatory = $true)][string]$Action,
        [string]$TunnelUrl
    )

    $path = Get-DevSpaceSupervisorHealStatePath -Config $Config
    $payload = [ordered]@{
        lastAction           = $Action
        lastTunnelRestartUtc = [datetime]::UtcNow.ToString("o")
        tunnelUrl            = $TunnelUrl
    }
    [System.IO.File]::WriteAllText($path, (($payload | ConvertTo-Json) + "`n"), [System.Text.Encoding]::UTF8)
}

function Test-DevSpaceSupervisorTunnelRestartCooldown {
    param(
        [Parameter(Mandatory = $true)][pscustomobject]$Config,
        [int]$CooldownSec = 300
    )

    $state = Read-DevSpaceSupervisorHealState -Config $Config
    if ($null -eq $state -or [string]::IsNullOrWhiteSpace([string]$state.lastTunnelRestartUtc)) {
        return $false
    }
    try {
        $when = [datetime]::Parse([string]$state.lastTunnelRestartUtc, $null, [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
        return (([datetime]::UtcNow) - $when).TotalSeconds -lt $CooldownSec
    } catch {
        return $false
    }
}

function Get-DevSpaceSupervisorConfig {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (!(Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Supervisor config missing: $Path"
    }
    $config = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    foreach ($required in @(
        "originTaskName", "repository", "cliPath", "cloudflaredExe", "runtimePath",
        "proxyTokenPath", "namedTunnelPath", "publicProxyBase", "localHost", "localPort",
        "supervisorLogPath", "quickTunnelStdoutLog", "quickTunnelStderrLog"
    )) {
        if ($null -eq $config.PSObject.Properties[$required] -or [string]::IsNullOrWhiteSpace([string]$config.$required)) {
            throw "Supervisor config is missing '$required'."
        }
    }
    return $config
}

function Get-DevSpaceSupervisorOriginProcesses {
    param([Parameter(Mandatory = $true)][pscustomobject]$Config)

    $cli = ([string]$Config.cliPath).ToLowerInvariant()
    return @(
        Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $line = [string]$_.CommandLine
                -not [string]::IsNullOrWhiteSpace($line) -and
                $line.ToLowerInvariant().Contains($cli) -and
                $line -match '(?i)(^|[\s\"])(serve)([\s\"]|$)'
            }
    )
}

function Get-DevSpaceSupervisorTunnelProcesses {
    param([Parameter(Mandatory = $true)][pscustomobject]$Config)

    $portMarker = "127.0.0.1:$($Config.localPort)"
    $namedName = $null
    if (Test-Path -LiteralPath $Config.namedTunnelPath -PathType Leaf) {
        try { $namedName = [string](Get-Content -LiteralPath $Config.namedTunnelPath -Raw | ConvertFrom-Json).name } catch {}
    }

    return @(
        Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $line = [string]$_.CommandLine
                # cloudflared often scrubs its command line after connecting.
                if ([string]::IsNullOrWhiteSpace($line)) { return $true }
                if ($line.Contains($portMarker)) { return $true }
                if (-not [string]::IsNullOrWhiteSpace($namedName) -and $line -match [regex]::Escape($namedName)) { return $true }
                return $false
            }
    )
}

function Initialize-DevSpaceProcessSecurityType {
    if ("DevSpaceProcessSecurity" -as [type]) { return }

    Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class DevSpaceProcessSecurity {
    private const uint READ_CONTROL = 0x00020000;
    private const uint WRITE_DAC = 0x00040000;
    private const uint WRITE_OWNER = 0x00080000;
    private const uint OWNER_SECURITY_INFORMATION = 0x00000001;
    private const uint DACL_SECURITY_INFORMATION = 0x00000004;
    private const uint PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LocalFree(IntPtr memory);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(
        string stringSecurityDescriptor,
        uint stringSDRevision,
        out IntPtr securityDescriptor,
        out uint securityDescriptorSize);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetSecurityDescriptorOwner(
        IntPtr securityDescriptor,
        out IntPtr owner,
        out bool ownerDefaulted);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetSecurityDescriptorDacl(
        IntPtr securityDescriptor,
        out bool daclPresent,
        out IntPtr dacl,
        out bool daclDefaulted);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint SetSecurityInfo(
        IntPtr handle,
        int objectType,
        uint securityInformation,
        IntPtr owner,
        IntPtr group,
        IntPtr dacl,
        IntPtr sacl);

    public static void Protect(int processId) {
        IntPtr process = OpenProcess(READ_CONTROL | WRITE_DAC | WRITE_OWNER, false, processId);
        if (process == IntPtr.Zero) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcess failed for PID " + processId);
        }

        IntPtr descriptor = IntPtr.Zero;
        try {
            // Process object owner is SYSTEM. Only SYSTEM and an elevated Administrators token
            // can reopen it with control rights. The ordinary interactive user therefore cannot
            // terminate, suspend, re-DACL, or take ownership of the protected runtime process.
            const string sddl = "O:SYD:P(A;;GA;;;SY)(A;;GA;;;BA)";
            uint size;
            if (!ConvertStringSecurityDescriptorToSecurityDescriptor(sddl, 1, out descriptor, out size)) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to build process security descriptor");
            }

            IntPtr owner;
            bool ownerDefaulted;
            if (!GetSecurityDescriptorOwner(descriptor, out owner, out ownerDefaulted) || owner == IntPtr.Zero) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to read process owner from security descriptor");
            }
            bool daclPresent;
            IntPtr dacl;
            bool daclDefaulted;
            if (!GetSecurityDescriptorDacl(descriptor, out daclPresent, out dacl, out daclDefaulted) || !daclPresent || dacl == IntPtr.Zero) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to read process DACL from security descriptor");
            }

            // SE_KERNEL_OBJECT = 6. SetSecurityInfo explicitly supports the protected-DACL
            // flag, unlike relying on object-specific inheritance behavior.
            uint securityInfo = OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION;
            uint result = SetSecurityInfo(process, 6, securityInfo, owner, IntPtr.Zero, dacl, IntPtr.Zero);
            if (result != 0) {
                throw new Win32Exception((int)result, "Unable to protect PID " + processId);
            }
        } finally {
            if (descriptor != IntPtr.Zero) LocalFree(descriptor);
            CloseHandle(process);
        }
    }
}
"@
}

function Protect-DevSpaceSupervisorProcess {
    param([Parameter(Mandatory = $true)][int]$ProcessId)

    Initialize-DevSpaceProcessSecurityType
    [DevSpaceProcessSecurity]::Protect($ProcessId)
}

function Protect-DevSpaceSupervisorRuntime {
    param([Parameter(Mandatory = $true)][pscustomobject]$Config)

    # PowerShell unwraps a single-element return, so CimInstance + CimInstance
    # is addition, not array concat. Force arrays before joining.
    $processes = @()
    $processes += @(Get-DevSpaceSupervisorOriginProcesses -Config $Config)
    $processes += @(Get-DevSpaceSupervisorTunnelProcesses -Config $Config)
    foreach ($process in $processes) {
        try {
            Protect-DevSpaceSupervisorProcess -ProcessId ([int]$process.ProcessId)
            Write-DevSpaceSupervisorLog "Protected runtime PID=$($process.ProcessId) name=$($process.Name) from unelevated process control."
        } catch {
            Write-DevSpaceSupervisorLog "Could not protect PID=$($process.ProcessId): $($_.Exception.Message)" "WARN"
        }
    }
}

function Read-DevSpaceSupervisorRuntimeState {
    param([Parameter(Mandatory = $true)][pscustomobject]$Config)

    if (!(Test-Path -LiteralPath $Config.runtimePath -PathType Leaf)) { return $null }
    try { return Get-Content -LiteralPath $Config.runtimePath -Raw | ConvertFrom-Json } catch { return $null }
}

function Register-DevSpaceSupervisorTunnel {
    param(
        [Parameter(Mandatory = $true)][pscustomobject]$Config,
        [Parameter(Mandatory = $true)][string]$TunnelUrl
    )

    if (!(Test-Path -LiteralPath $Config.proxyTokenPath -PathType Leaf)) {
        throw "Proxy token missing: $($Config.proxyTokenPath)"
    }
    $token = (Get-Content -LiteralPath $Config.proxyTokenPath -Raw).Trim()
    if ([string]::IsNullOrWhiteSpace($token)) { throw "Proxy token is empty." }

    $response = Invoke-WebRequest -UseBasicParsing -Method Post `
        -Uri "$($Config.publicProxyBase)/set-tunnel" `
        -Headers @{ "X-Auth-Token" = $token } `
        -ContentType "text/plain" `
        -Body $TunnelUrl `
        -TimeoutSec 15
    if ([int]$response.StatusCode -lt 200 -or [int]$response.StatusCode -ge 300) {
        throw "Worker tunnel registration failed with HTTP $($response.StatusCode)."
    }
    Write-DevSpaceSupervisorLog "Registered Worker upstream: $TunnelUrl"
}

function Get-DevSpaceSupervisorQuickTunnelUrlFromLogs {
    param([Parameter(Mandatory = $true)][pscustomobject]$Config)

    $text = ""
    foreach ($path in @($Config.quickTunnelStdoutLog, $Config.quickTunnelStderrLog)) {
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            try { $text += "`n" + (Get-Content -LiteralPath $path -Raw -ErrorAction SilentlyContinue) } catch {}
        }
    }
    $matches = [regex]::Matches($text, "https://[a-zA-Z0-9\-]+\.trycloudflare\.com")
    if ($matches.Count -eq 0) { return $null }
    return $matches[$matches.Count - 1].Value
}

function Start-DevSpaceSupervisorQuickTunnel {
    param([Parameter(Mandatory = $true)][pscustomobject]$Config)

    foreach ($path in @($Config.quickTunnelStdoutLog, $Config.quickTunnelStderrLog)) {
        Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    }
    $arguments = @(
        "tunnel", "--url", "http://$($Config.localHost):$($Config.localPort)",
        "--protocol", "http2", "--edge-ip-version", "4", "--no-autoupdate", "--loglevel", "info",
        "--logfile", $Config.quickTunnelStderrLog
    )
    $commandLine = '"{0}" {1}' -f $Config.cloudflaredExe, ($arguments -join " ")
    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = $commandLine
    }
    if ($created.ReturnValue -ne 0 -or -not $created.ProcessId) {
        throw "Supervisor failed to start cloudflared via WMI (ReturnValue=$($created.ReturnValue))."
    }
    $process = Get-Process -Id $created.ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        throw "Supervisor started cloudflared PID $($created.ProcessId) but the process handle was missing."
    }
    Write-DevSpaceSupervisorLog "Started quick tunnel PID=$($process.Id)."
    try { Protect-DevSpaceSupervisorProcess -ProcessId $process.Id } catch {}

    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 500
        $url = Get-DevSpaceSupervisorQuickTunnelUrlFromLogs -Config $Config
        if (-not [string]::IsNullOrWhiteSpace($url)) { return $url }
        if ($null -eq (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) { break }
    }
    throw "cloudflared did not publish a quick-tunnel URL."
}

function Start-DevSpaceSupervisorNamedTunnel {
    param(
        [Parameter(Mandatory = $true)][pscustomobject]$Config,
        [Parameter(Mandatory = $true)][pscustomobject]$NamedTunnel
    )

    if ([string]::IsNullOrWhiteSpace([string]$NamedTunnel.name)) { return $null }
    $arguments = @("tunnel")
    if (-not [string]::IsNullOrWhiteSpace([string]$NamedTunnel.configPath)) {
        $arguments += @("--config", [string]$NamedTunnel.configPath)
    }
    $arguments += @("run", [string]$NamedTunnel.name)
    $process = Start-Process -FilePath $Config.cloudflaredExe -ArgumentList $arguments -WindowStyle Hidden -PassThru
    Write-DevSpaceSupervisorLog "Started named tunnel '$($NamedTunnel.name)' PID=$($process.Id)."
    try { Protect-DevSpaceSupervisorProcess -ProcessId $process.Id } catch {}
    return $process
}

function Ensure-DevSpaceSupervisorTunnel {
    param(
        [Parameter(Mandatory = $true)][pscustomobject]$Config,
        $PublicMcpProbe
    )

    if ($null -eq $PublicMcpProbe) {
        $PublicMcpProbe = Get-DevSpaceSupervisorPublicMcpProbe -Config $Config
    }
    if ($PublicMcpProbe.Kind -eq "reached") {
        Write-DevSpaceSupervisorLog "Public POST /mcp reached origin HTTP=$($PublicMcpProbe.StatusCode); skipping tunnel heal."
        return
    }
    $workerHealthzOk = Test-DevSpaceSupervisorHealthz -Url "$($Config.publicProxyBase)/healthz" -TimeoutSec 8
    if ($PublicMcpProbe.Kind -ne "upstream-failure") {
        if ($workerHealthzOk) {
            Write-DevSpaceSupervisorLog "Skipping tunnel heal; POST /mcp probe kind=$($PublicMcpProbe.Kind) HTTP=$($PublicMcpProbe.StatusCode) and Worker /healthz is DevSpace JSON."
            return
        }
        Write-DevSpaceSupervisorLog "POST /mcp probe kind=$($PublicMcpProbe.Kind) HTTP=$($PublicMcpProbe.StatusCode) and Worker /healthz is not DevSpace JSON; healing tunnel." "WARN"
    } else {
        Write-DevSpaceSupervisorLog "Public 502/530 confirmed HTTP=$($PublicMcpProbe.StatusCode); healing tunnel/Worker, not rebooting origin. body=$($PublicMcpProbe.Preview)" "WARN"
    }

    $named = $null
    if (Test-Path -LiteralPath $Config.namedTunnelPath -PathType Leaf) {
        try { $named = Get-Content -LiteralPath $Config.namedTunnelPath -Raw | ConvertFrom-Json } catch {}
    }
    $namedReady = $named -and
        -not [string]::IsNullOrWhiteSpace([string]$named.name) -and
        -not [string]::IsNullOrWhiteSpace([string]$named.url) -and
        -not [string]::IsNullOrWhiteSpace([string]$named.configPath) -and
        (Test-Path -LiteralPath ([string]$named.configPath) -PathType Leaf)
    if ($namedReady) {
        $namedProcesses = @(Get-DevSpaceSupervisorTunnelProcesses -Config $Config)
        if ($namedProcesses.Count -eq 0) {
            [void](Start-DevSpaceSupervisorNamedTunnel -Config $Config -NamedTunnel $named)
            Start-Sleep -Seconds 2
        }
        Register-DevSpaceSupervisorTunnel -Config $Config -TunnelUrl ([string]$named.url)
        return
    }
    if ($named -and -not [string]::IsNullOrWhiteSpace([string]$named.name)) {
        Write-DevSpaceSupervisorLog "named-tunnel.json is incomplete; require name, url, and an existing configPath. Using quick-tunnel fallback." "WARN"
    }

    $runtime = Read-DevSpaceSupervisorRuntimeState -Config $Config
    $rememberedUrl = if ($runtime) { [string]$runtime.tunnelUrl } else { $null }
    $quickProcesses = @(Get-DevSpaceSupervisorTunnelProcesses -Config $Config)
    $inCooldown = Test-DevSpaceSupervisorTunnelRestartCooldown -Config $Config
    if ($quickProcesses.Count -gt 0 -and -not [string]::IsNullOrWhiteSpace($rememberedUrl)) {
        if (Test-DevSpaceSupervisorHealthz -Url ($rememberedUrl.TrimEnd('/') + "/healthz") -TimeoutSec 5) {
            Register-DevSpaceSupervisorTunnel -Config $Config -TunnelUrl $rememberedUrl
            return
        }
        if ($inCooldown) {
            Register-DevSpaceSupervisorTunnel -Config $Config -TunnelUrl $rememberedUrl
            Write-DevSpaceSupervisorLog "Tunnel remint cooldown active; reregistered $rememberedUrl without replacing cloudflared."
            return
        }
    }
    if ($inCooldown -and $quickProcesses.Count -gt 0) {
        Write-DevSpaceSupervisorLog "Tunnel remint cooldown active; leaving live cloudflared in place."
        return
    }

    # Public 502/530 and the remembered quick tunnel is not usable. Replace
    # cloudflared only; the healthy origin is never recycled for a routing failure.
    foreach ($process in $quickProcesses) {
        try { Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue } catch {}
    }
    $newUrl = Start-DevSpaceSupervisorQuickTunnel -Config $Config
    Register-DevSpaceSupervisorTunnel -Config $Config -TunnelUrl $newUrl
    Write-DevSpaceSupervisorHealState -Config $Config -Action "restart-tunnel" -TunnelUrl $newUrl
    for ($i = 0; $i -lt 8; $i++) {
        if (Test-DevSpaceSupervisorPublicMcpReachedOrigin -Config $Config) {
            Write-DevSpaceSupervisorLog "Public POST /mcp reached origin after tunnel remint."
            return
        }
        Start-Sleep -Seconds 3
    }
    Write-DevSpaceSupervisorLog "Public POST /mcp still not origin-ready after remint; next supervisor tick will reregister during cooldown." "WARN"
}

function Recover-DevSpaceSupervisorOrigin {
    param([Parameter(Mandatory = $true)][pscustomobject]$Config)

    Write-DevSpaceSupervisorLog "Verified local origin is down; starting pinned user-origin task." "WARN"
    foreach ($process in @(Get-DevSpaceSupervisorOriginProcesses -Config $Config)) {
        try { Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue } catch {}
    }

    # The origin task now owns a PowerShell Job-Object wrapper around node.exe.
    # After node exits, give the wrapper a bounded window to close the job and
    # transition the scheduled task out of Running. Starting while it is still
    # Running would be silently ignored because MultipleInstances=IgnoreNew.
    $originStopped = $false
    for ($i = 0; $i -lt 40; $i++) {
        $state = (Get-ScheduledTask -TaskName $Config.originTaskName -ErrorAction Stop).State
        if ($state -ne "Running") {
            $originStopped = $true
            break
        }
        Start-Sleep -Milliseconds 250
    }
    if (-not $originStopped) {
        Write-DevSpaceSupervisorLog "Origin wrapper did not stop after node exit; stopping the scheduled task before restart." "WARN"
        Stop-ScheduledTask -TaskName $Config.originTaskName -ErrorAction SilentlyContinue
        for ($i = 0; $i -lt 20; $i++) {
            if ((Get-ScheduledTask -TaskName $Config.originTaskName -ErrorAction Stop).State -ne "Running") {
                $originStopped = $true
                break
            }
            Start-Sleep -Milliseconds 250
        }
    }
    if (-not $originStopped) {
        throw "Origin task '$($Config.originTaskName)' remained Running after forced stop."
    }

    Start-ScheduledTask -TaskName $Config.originTaskName
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 1
        if (Test-DevSpaceSupervisorHealthz -Url "http://$($Config.localHost):$($Config.localPort)/healthz") {
            Protect-DevSpaceSupervisorRuntime -Config $Config
            Write-DevSpaceSupervisorLog "Origin recovered by task '$($Config.originTaskName)'."
            return
        }
    }
    throw "Origin task '$($Config.originTaskName)' did not restore /healthz within 30 seconds."
}

if ($LibraryOnly) { return }

$config = Get-DevSpaceSupervisorConfig -Path $ConfigPath
$script:SupervisorLogPath = [string]$config.supervisorLogPath
$logDirectory = Split-Path -Parent $script:SupervisorLogPath
if (-not [string]::IsNullOrWhiteSpace($logDirectory) -and !(Test-Path -LiteralPath $logDirectory)) {
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
}

try {
    Protect-DevSpaceSupervisorRuntime -Config $config
    $localHealthy = Test-DevSpaceSupervisorLocalStable -Config $config
    $publicMcpProbe = Get-DevSpaceSupervisorPublicMcpProbe -Config $config
    $tunnelAlive = (@(Get-DevSpaceSupervisorTunnelProcesses -Config $config).Count -gt 0)
    if (-not $localHealthy) {
        Write-DevSpaceSupervisorLog "Local origin is down (public 502/530 class); rebooting origin task only." "WARN"
        Recover-DevSpaceSupervisorOrigin -Config $config
        $localHealthy = $true
    } elseif ($publicMcpProbe.Kind -eq "reached") {
        Write-DevSpaceSupervisorLog "Local origin healthy and POST /mcp reached origin HTTP=$($publicMcpProbe.StatusCode)."
    } elseif ($publicMcpProbe.Kind -eq "upstream-failure") {
        Write-DevSpaceSupervisorLog "Local origin is healthy; confirmed public 502/530 HTTP=$($publicMcpProbe.StatusCode) will heal tunnel, not Node. tunnelAlive=$tunnelAlive"
    } else {
        Write-DevSpaceSupervisorLog "Local origin is healthy; POST /mcp probe kind=unknown HTTP=$($publicMcpProbe.StatusCode). Skip-heal unless Worker /healthz is also down."
    }
    Protect-DevSpaceSupervisorRuntime -Config $config
    Ensure-DevSpaceSupervisorTunnel -Config $config -PublicMcpProbe $publicMcpProbe
    Protect-DevSpaceSupervisorRuntime -Config $config
    exit 0
} catch {
    Write-DevSpaceSupervisorLog $_.Exception.Message "ERROR"
    throw
}
