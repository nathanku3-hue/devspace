# Operator-only installer for the DevSpace runtime supervisor.
# Run once from an elevated interactive Windows PowerShell console.
# By default it does not stop or recycle a healthy origin. Pass -ApplyNow
# for one bounded, verified recycle after the protected tasks are installed.
[CmdletBinding()]
param(
    [string]$SupervisorTaskName = "DevSpaceOriginSupervisor",
    [string]$OriginTaskName = "DevSpaceOriginUser",
    [int]$ShellMaxActive = 4,
    [int]$ShellMaxActivePerWorkspace = 2,
    [int]$ShellMaxQueued = 16,
    [int]$FastPathQueueWaitMs = 8000,
    [int]$FastPathExecutionMs = 15000,
    [switch]$ApplyNow
)

$ErrorActionPreference = "Stop"

if ($ShellMaxActive -lt 1) { throw "ShellMaxActive must be at least 1." }
if ($ShellMaxActivePerWorkspace -lt 1) { throw "ShellMaxActivePerWorkspace must be at least 1." }
if ($ShellMaxActivePerWorkspace -gt $ShellMaxActive) {
    throw "ShellMaxActivePerWorkspace cannot exceed ShellMaxActive."
}
if ($ShellMaxQueued -lt 1) { throw "ShellMaxQueued must be at least 1." }
if ($FastPathQueueWaitMs -lt 1) { throw "FastPathQueueWaitMs must be at least 1." }
if ($FastPathExecutionMs -lt 1) { throw "FastPathExecutionMs must be at least 1." }

function Assert-DevSpaceElevatedOperator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Install the DevSpace supervisor from an elevated operator console. MCP bash is intentionally unable to do this."
    }
    return $identity
}

function Resolve-DevSpaceOperatorPath {
    param(
        [string]$Value,
        [Parameter(Mandatory = $true)][string]$OperatorProfile,
        [Parameter(Mandatory = $true)][string]$Repository,
        [Parameter(Mandatory = $true)][string]$Fallback
    )

    if ([string]::IsNullOrWhiteSpace($Value)) { return $Fallback }
    if ($Value -eq "~") { return $OperatorProfile }
    if ($Value.StartsWith("~\") -or $Value.StartsWith("~/")) {
        return [System.IO.Path]::GetFullPath((Join-Path $OperatorProfile $Value.Substring(2)))
    }
    if ([System.IO.Path]::IsPathRooted($Value)) {
        return [System.IO.Path]::GetFullPath($Value)
    }
    return [System.IO.Path]::GetFullPath((Join-Path $Repository $Value))
}

function Escape-DevSpaceBatchValue {
    param([string]$Value)

    if ($null -eq $Value) { return "" }
    # Percent expansion is the only material hazard inside set "NAME=value" here.
    return $Value.Replace("%", "%%")
}

function Set-DevSpaceTaskSecurity {
    param([Parameter(Mandatory = $true)][string]$TaskName)

    $service = New-Object -ComObject "Schedule.Service"
    $service.Connect()
    $folder = $service.GetFolder("\")
    $task = $folder.GetTask("\$TaskName")
    # Only SYSTEM and an elevated Administrators token can mutate/control these
    # tasks. The ordinary interactive account is deliberately not granted task
    # control even though the origin task runs with that account's interactive token.
    $task.SetSecurityDescriptor("O:BAG:SYD:P(A;;GA;;;SY)(A;;GA;;;BA)", 0)
}

$identity = Assert-DevSpaceElevatedOperator
$operatorAccount = $identity.Name
$operatorProfile = $env:USERPROFILE
$operatorSid = $identity.User.Value

$repository = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if ($repository -match '(?i)\\.worktrees\\' -or (Test-Path -LiteralPath (Join-Path $repository ".git") -PathType Leaf)) {
    throw "Refusing to install production supervision from a Git worktree: $repository"
}
$cliPath = Join-Path $repository "dist\cli.js"
if (!(Test-Path -LiteralPath $cliPath -PathType Leaf)) {
    throw "Built DevSpace CLI missing: $cliPath"
}

$sourceSupervisor = Join-Path $PSScriptRoot "devspace-supervisor.ps1"
if (!(Test-Path -LiteralPath $sourceSupervisor -PathType Leaf)) {
    throw "Supervisor source script missing: $sourceSupervisor"
}
$sourceOriginRunner = Join-Path $PSScriptRoot "devspace-origin-runner.ps1"
if (!(Test-Path -LiteralPath $sourceOriginRunner -PathType Leaf)) {
    throw "Origin runner source script missing: $sourceOriginRunner"
}

$nodeCommand = Get-Command node.exe -ErrorAction Stop
$cloudflaredCommand = Get-Command cloudflared.exe -ErrorAction Stop
$nodeExe = $nodeCommand.Source
$cloudflaredExe = $cloudflaredCommand.Source

$configDir = Join-Path $operatorProfile ".devspace"
$configPath = Join-Path $configDir "config.json"
$authPath = Join-Path $configDir "auth.json"
$proxyTokenPath = Join-Path $configDir "proxy_token.txt"
$runtimePath = Join-Path $configDir "runtime.json"
$namedTunnelPath = Join-Path $configDir "named-tunnel.json"
foreach ($requiredFile in @($configPath, $authPath, $proxyTokenPath)) {
    if (!(Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Required DevSpace runtime file missing: $requiredFile"
    }
}

$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$publicProxyBase = if ([string]::IsNullOrWhiteSpace([string]$config.publicBaseUrl)) {
    "https://devspace-proxy.kitlongku.workers.dev"
} else {
    [string]$config.publicBaseUrl
}
$proxyHost = ([System.Uri]$publicProxyBase).Host
$localHost = if ([string]::IsNullOrWhiteSpace([string]$config.host)) { "127.0.0.1" } else { [string]$config.host }
$localPort = if ($config.port) { [int]$config.port } else { 7676 }
$allowedRoots = @($config.allowedRoots | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
if ($allowedRoots.Count -eq 0) { $allowedRoots = @($repository) }
$stateDir = Resolve-DevSpaceOperatorPath `
    -Value ([string]$config.stateDir) `
    -OperatorProfile $operatorProfile `
    -Repository $repository `
    -Fallback (Join-Path $operatorProfile ".local\share\devspace")
$agentDir = Resolve-DevSpaceOperatorPath `
    -Value ([string]$config.agentDir) `
    -OperatorProfile $operatorProfile `
    -Repository $repository `
    -Fallback (Join-Path $operatorProfile ".codex")

$machineRoot = Join-Path $env:ProgramData "DevSpace"
$logsDir = Join-Path $machineRoot "logs"
$machineSupervisor = Join-Path $machineRoot "devspace-supervisor.ps1"
$machineOriginRunner = Join-Path $machineRoot "devspace-origin-runner.ps1"
$machineConfigPath = Join-Path $machineRoot "supervisor.json"
$originLaunchPath = Join-Path $machineRoot "origin-launch.cmd"
$supervisorLogPath = Join-Path $logsDir "supervisor.log"
$originStdoutLog = Join-Path $logsDir "origin-stdout.log"
$originStderrLog = Join-Path $logsDir "origin-stderr.log"
$quickTunnelStdoutLog = Join-Path $logsDir "quick-tunnel-stdout.log"
$quickTunnelStderrLog = Join-Path $logsDir "quick-tunnel-stderr.log"

New-Item -ItemType Directory -Path $machineRoot -Force | Out-Null
New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
Copy-Item -LiteralPath $sourceSupervisor -Destination $machineSupervisor -Force
Copy-Item -LiteralPath $sourceOriginRunner -Destination $machineOriginRunner -Force

$machineConfig = [ordered]@{
    version = 2
    supervisorTaskName = $SupervisorTaskName
    originTaskName = $OriginTaskName
    operatorAccount = $operatorAccount
    operatorSid = $operatorSid
    operatorProfile = $operatorProfile
    repository = $repository
    cliPath = $cliPath
    nodeExe = $nodeExe
    cloudflaredExe = $cloudflaredExe
    configDir = $configDir
    runtimePath = $runtimePath
    proxyTokenPath = $proxyTokenPath
    namedTunnelPath = $namedTunnelPath
    publicProxyBase = $publicProxyBase
    localHost = $localHost
    localPort = $localPort
    supervisorLogPath = $supervisorLogPath
    quickTunnelStdoutLog = $quickTunnelStdoutLog
    quickTunnelStderrLog = $quickTunnelStderrLog
}
[System.IO.File]::WriteAllText(
    $machineConfigPath,
    (($machineConfig | ConvertTo-Json -Depth 5) + "`r`n"),
    [System.Text.Encoding]::UTF8
)

$allowedHosts = @($proxyHost, "*.trycloudflare.com", "localhost", "127.0.0.1")
if ($config.allowedHosts) {
    $allowedHosts += @($config.allowedHosts | ForEach-Object { [string]$_ })
}
$allowedHosts = @($allowedHosts | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)

$envLines = @(
    '@echo off',
    'setlocal',
    ('set "DEVSPACE_CONFIG_DIR={0}"' -f (Escape-DevSpaceBatchValue $configDir)),
    ('set "DEVSPACE_STATE_DIR={0}"' -f (Escape-DevSpaceBatchValue $stateDir)),
    ('set "DEVSPACE_AGENT_DIR={0}"' -f (Escape-DevSpaceBatchValue $agentDir)),
    ('set "DEVSPACE_PUBLIC_BASE_URL={0}"' -f (Escape-DevSpaceBatchValue $publicProxyBase)),
    ('set "DEVSPACE_ALLOWED_HOSTS={0}"' -f (Escape-DevSpaceBatchValue ($allowedHosts -join ','))),
    ('set "DEVSPACE_ALLOWED_ROOTS={0}"' -f (Escape-DevSpaceBatchValue ($allowedRoots -join ','))),
    'set "DEVSPACE_TRUST_PROXY=true"',
    'set "DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS=chatgpt.com,claude.ai,perplexity.ai,*.perplexity.ai,www.perplexity.com,enterprise.perplexity.com,n.perplexity.com,staging.perplexity.com,chatshare.xyz,*.chatshare.xyz,localhost,127.0.0.1"',
    'set "DEVSPACE_OAUTH_REDIRECT_URI_ALIASES=https://chatgpt.com/connector/oauth/=https://chatshare.xyz/connector/oauth/"',
    'set "DEVSPACE_DEVICE_AUTH=true"',
    'set "DEVSPACE_DEVICE_AUTH_REQUIRED=false"',
    'set "DEVSPACE_DEVICE_AUTH_LOOPBACK_PORT=7677"',
    'set "DEVSPACE_DEVICE_AUTH_EXTENSION_ID=aaoelopmdnhifffjefciagfmhjanbaoc"',
    'set "DEVSPACE_DEVICE_AUTH_ALLOWED_REDIRECT_PREFIXES=https://chatgpt.com/connector/oauth/,https://chatshare.xyz/connector/oauth/,https://chatshare.xyz/connector_platform_oauth_redirect"',
    'set "DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS=86400"',
    'set "GIT_TERMINAL_PROMPT=0"',
    'set "GIT_EDITOR=true"',
    'set "GIT_ASKPASS=true"',
    'set "GCM_INTERACTIVE=never"',
    ('set "DEVSPACE_SHELL_MAX_ACTIVE={0}"' -f $ShellMaxActive),
    ('set "DEVSPACE_SHELL_MAX_ACTIVE_PER_WORKSPACE={0}"' -f $ShellMaxActivePerWorkspace),
    ('set "DEVSPACE_SHELL_MAX_QUEUED={0}"' -f $ShellMaxQueued),
    'set "DEVSPACE_SHELL_QUEUE_TIMEOUT_MS=60000"',
    ('set "DEVSPACE_FAST_PATH_QUEUE_WAIT_MS={0}"' -f $FastPathQueueWaitMs),
    ('set "DEVSPACE_FAST_PATH_EXECUTION_MS={0}"' -f $FastPathExecutionMs),
    'set "DEVSPACE_SHELL_MAX_OUTPUT_BYTES=8388608"',
    # Keep the V8 cap scoped to the DevSpace origin itself. Do not use NODE_OPTIONS:
    # bash children such as npm/tsc/vite must not inherit the server heap limit.
    ('cd /d "{0}"' -f (Escape-DevSpaceBatchValue $repository)),
    ('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{0}" -NodeExe "{1}" -CliPath "{2}" -Repository "{3}" -MaxOldSpaceMb 512 1>>"{4}" 2>>"{5}"' -f `
        (Escape-DevSpaceBatchValue $machineOriginRunner), `
        (Escape-DevSpaceBatchValue $nodeExe), `
        (Escape-DevSpaceBatchValue $cliPath), `
        (Escape-DevSpaceBatchValue $repository), `
        (Escape-DevSpaceBatchValue $originStdoutLog), `
        (Escape-DevSpaceBatchValue $originStderrLog))
)
[System.IO.File]::WriteAllLines($originLaunchPath, $envLines, [System.Text.Encoding]::ASCII)

# Machine-owned supervisor files are immutable to the ordinary operator/MCP token.
# The interactive user gets read/execute only so Task Scheduler can run the launch
# wrapper under that identity. Only the logs directory is writable by that user.
& icacls.exe $machineRoot /inheritance:r | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Failed to disable inheritance on $machineRoot" }
$operatorRead = "*{0}:(OI)(CI)RX" -f $operatorSid
& icacls.exe $machineRoot /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" $operatorRead | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Failed to protect $machineRoot" }
$operatorModify = "*{0}:(OI)(CI)M" -f $operatorSid
& icacls.exe $logsDir /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" $operatorModify | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Failed to grant runtime log access." }

$originActionArguments = "/d /s /c `"`"$originLaunchPath`"`""
$originAction = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $originActionArguments -WorkingDirectory $repository
$originPrincipal = New-ScheduledTaskPrincipal -UserId $operatorAccount -LogonType Interactive -RunLevel Limited
$originSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask `
    -TaskName $OriginTaskName `
    -Action $originAction `
    -Settings $originSettings `
    -Principal $originPrincipal `
    -Force | Out-Null

$supervisorAction = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$machineSupervisor`" -ConfigPath `"$machineConfigPath`"" `
    -WorkingDirectory $machineRoot
$triggerMinute = New-ScheduledTaskTrigger `
    -Once `
    -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 1) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
$triggerStart = New-ScheduledTaskTrigger -AtStartup
$supervisorSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
$supervisorPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask `
    -TaskName $SupervisorTaskName `
    -Action $supervisorAction `
    -Trigger @($triggerStart, $triggerMinute) `
    -Settings $supervisorSettings `
    -Principal $supervisorPrincipal `
    -Force | Out-Null

Set-DevSpaceTaskSecurity -TaskName $OriginTaskName
Set-DevSpaceTaskSecurity -TaskName $SupervisorTaskName

# Do not recycle. The first SYSTEM pass protects the currently healthy PIDs in
# place, and only starts the user-origin task when verified /healthz is down.
Start-ScheduledTask -TaskName $SupervisorTaskName
Start-Sleep -Seconds 2

$supervisorInfo = Get-ScheduledTask -TaskName $SupervisorTaskName
$originInfo = Get-ScheduledTask -TaskName $OriginTaskName
Write-Host "Installed protected DevSpace supervision." -ForegroundColor Green
Write-Host "  Supervisor: $SupervisorTaskName ($($supervisorInfo.State), SYSTEM)"
Write-Host "  Origin task: $OriginTaskName ($($originInfo.State), $operatorAccount interactive token)"
Write-Host "  Machine config: $machineConfigPath"
Write-Host "  Machine supervisor: $machineSupervisor"
Write-Host "  Machine origin runner: $machineOriginRunner"
Write-Host "  Logs: $logsDir"

if ($ApplyNow) {
    Write-Host "Applying the protected origin runtime now..." -ForegroundColor Yellow

    # Stop the scheduled wrapper and any matching legacy origin process. This
    # handles both the old direct-node task and the new Job-Object wrapper.
    Stop-ScheduledTask -TaskName $OriginTaskName -ErrorAction SilentlyContinue
    $cliMarker = $cliPath.ToLowerInvariant()
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $line = [string]$_.CommandLine
            -not [string]::IsNullOrWhiteSpace($line) -and
            $line.ToLowerInvariant().Contains($cliMarker) -and
            $line -match '(?i)(^|[\s\"])(serve)([\s\"]|$)'
        } |
        ForEach-Object {
            Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue
        }

    $stopped = $false
    for ($i = 0; $i -lt 40; $i++) {
        if ((Get-ScheduledTask -TaskName $OriginTaskName -ErrorAction Stop).State -ne "Running") {
            $stopped = $true
            break
        }
        Start-Sleep -Milliseconds 250
    }
    if (-not $stopped) {
        throw "Origin task '$OriginTaskName' did not stop during -ApplyNow."
    }

    Start-ScheduledTask -TaskName $OriginTaskName
    $healthy = $false
    $healthUrl = "http://${localHost}:$localPort/healthz"
    for ($i = 0; $i -lt 60; $i++) {
        try {
            $body = & curl.exe -s --noproxy "*" --max-time 2 $healthUrl 2>$null
            if (-not [string]::IsNullOrWhiteSpace($body)) {
                $parsed = $body | ConvertFrom-Json
                if ($parsed.ok -eq $true -and [string]$parsed.name -eq "devspace") {
                    $healthy = $true
                    break
                }
            }
        } catch {}
        Start-Sleep -Milliseconds 500
    }
    if (-not $healthy) {
        throw "Protected origin did not restore $healthUrl during -ApplyNow."
    }

    # Re-run one supervisor pass so the fresh Node PID and tunnel are protected.
    Start-ScheduledTask -TaskName $SupervisorTaskName
    Write-Host "Protected DevSpace origin is healthy and active." -ForegroundColor Green
} else {
    Write-Host "A healthy origin was not recycled. Re-run with -ApplyNow to activate the new origin wrapper immediately."
}
