# Usage from E:\Code\devspace (run in interactive Windows PowerShell, not DevSpace bash):
#   powershell -ExecutionPolicy Bypass -File E:\Code\devspace\setup_devspace.ps1
#   powershell -ExecutionPolicy Bypass -File E:\Code\devspace\setup_devspace.ps1 -Monitor
# Model-facing launchers do not accept -Stop. Operator stop is scripts\operator-stop-devspace.ps1.
# Canonical version-controlled implementation: devspace-src\scripts\setup-devspace.ps1
#
# The live MCP runtime must expose the exact tools/list snapshot below.
# ChatGPT custom-app action schemas are separate snapshots: refresh or republish
# the app after changing tools, and start a new conversation to adopt the schema.
[CmdletBinding()]
param(
    [switch]$Monitor,
    [switch]$LibraryOnly,
    [switch]$Reregister,
    [switch]$AllowDirty,
    [switch]$OverridePreferredSource,
    [switch]$PinPreferredSource
)
if (-not $LibraryOnly -and $MyInvocation.UnboundArguments -and $MyInvocation.UnboundArguments.Count -gt 0) {
    throw "Unexpected arguments: $($MyInvocation.UnboundArguments -join ' '). Model-facing setup does not accept -Stop."
}

# Keep the console visible even when launched once from an older hidden startup shortcut.
if (-not ("DevSpaceConsoleWindow" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class DevSpaceConsoleWindow {
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetConsoleWindow();

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
}
$consoleWindow = [DevSpaceConsoleWindow]::GetConsoleWindow()
if ($consoleWindow -ne [IntPtr]::Zero) {
    [DevSpaceConsoleWindow]::ShowWindow($consoleWindow, 5) | Out-Null
}
try { $Host.UI.RawUI.WindowTitle = "DevSpace - close this window to stop" } catch {}

$ErrorActionPreference = "Stop"
# PowerShell 7.3+ can treat native non-zero exits as terminating; never do that here.
if (Test-Path variable:/PSNativeCommandUseErrorActionPreference) {
    $PSNativeCommandUseErrorActionPreference = $false
}
$script:intentionalStop = $false
$script:leaveRunning = $false
$script:cloudflaredProcess = $null
$script:devspaceProcess = $null
$script:setupLogFile = Join-Path $env:TEMP "devspace_setup.log"
$script:runtimePidFile = Join-Path $env:USERPROFILE ".devspace\runtime.json"
$script:probeClientFile = Join-Path $env:USERPROFILE ".devspace\setup-probe-client.json"
$script:setupLockFile = Join-Path $env:USERPROFILE ".devspace\setup.lock"
$script:setupLockHeld = $false
$script:previousDistDirectory = $null

$PublicProxyBase = "https://devspace-proxy.kitlongku.workers.dev"
$LocalHost = "127.0.0.1"
$LocalPort = 7676
$DeviceProofPort = 7677
$PrimaryAllowedRoot = "E:\Code"
# Temporary custody-migration allowance. This permits DevSpace to open and
# rescue existing managed worktrees in place; it is not an approved destination
# for newly created worktrees and should be removed after migration acceptance.
$LegacyWorktreeMigrationRoot = Join-Path $env:USERPROFILE ".devspace\worktrees"
$AllowedRoots = @($PrimaryAllowedRoot, $LegacyWorktreeMigrationRoot)
$AllowedRootsEnv = $AllowedRoots -join ","
$ExpectedTools = @(
    "bash",
    "cancel_long_task",
    "close_workspace",
    "continue_meta_harness",
    "create_worktree_workspace",
    "edit",
    "long_task_status",
    "open_workspace",
    "publish_git_changes",
    "read",
    "read_files",
    "safe_rename_file",
    "start_long_task",
    "web_launch",
    "write"
)
. (Join-Path $PSScriptRoot "setup-devspace-support.ps1")
. (Join-Path $PSScriptRoot "setup-devspace-lifecycle.ps1")

function Write-SetupLog {
    param([string]$Message, [string]$Level = "INFO")
    $line = "{0} [{1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level, $Message
    try { Add-Content -Path $script:setupLogFile -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue } catch {}
    if ($Level -eq "ERROR") {
        Write-Host $Message -ForegroundColor Red
    } elseif ($Level -eq "WARN") {
        Write-Warning $Message
    } else {
        Write-Host $Message
    }
}

function Set-DevSpaceStartupShortcut {
    Write-Host "Configuring visible DevSpace startup terminal..."
    try {
        $startupFolder = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
        $shortcutPath = Join-Path $startupFolder "DevSpace.lnk"
        $sourceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
        $operatorRoot = Split-Path -Parent $sourceRoot
        $rootLauncher = Join-Path $operatorRoot "setup_devspace.ps1"
        if (-not (Test-Path -LiteralPath $rootLauncher -PathType Leaf)) {
            Write-Warning "Root operator launcher not found at $rootLauncher; leaving startup shortcut unchanged."
            return
        }

        $WshShell = New-Object -ComObject WScript.Shell
        $Shortcut = $WshShell.CreateShortcut($shortcutPath)
        $Shortcut.TargetPath = "powershell.exe"
        $Shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$rootLauncher`""
        $Shortcut.WorkingDirectory = $operatorRoot
        $Shortcut.WindowStyle = 1
        $Shortcut.Save()
        Write-Host "Visible startup shortcut configured at: $shortcutPath -> $rootLauncher"
    } catch {
        Write-Warning "Failed to configure startup shortcut: $_"
    }
}

function Test-PortOpen([string]$hostName, [int]$port, [int]$timeoutMs = 150) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $ar = $client.BeginConnect($hostName, $port, $null, $null)
        $wait = $ar.AsyncWaitHandle.WaitOne($timeoutMs, $false)
        if ($wait -and $client.Connected) {
            return $true
        }
    } catch {
    } finally {
        $client.Close()
    }
    return $false
}

function Get-SafeExitCode([System.Diagnostics.Process]$process) {
    if ($null -eq $process) {
        return "no-process"
    }
    try {
        $process.Refresh()
    } catch {
        return "refresh-failed"
    }
    if (-not $process.HasExited) {
        return "still-running"
    }
    try {
        # WaitForExit is required on Windows before ExitCode is reliable.
        if (-not $process.WaitForExit(5000)) {
            return "exited-but-wait-timeout"
        }
        # Prefer raw .NET access; PS sometimes surfaces a null wrapper.
        $code = $process.ExitCode
        if ($null -eq $code) {
            return "unknown (Windows reported no exit code; often Ctrl+C, taskkill, or console signal)"
        }
        return ([int]$code).ToString()
    } catch {
        return "unavailable:$($_.Exception.Message)"
    }
}

function Test-ManagedProcessAlive([System.Diagnostics.Process]$process) {
    if ($null -eq $process) {
        return $false
    }
    try {
        $process.Refresh()
        if (-not $process.HasExited) {
            return $true
        }
    } catch {
        # fall through to PID probe
    }
    # False-positive HasExited: confirm via kernel process table.
    try {
        $byId = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
        return ($null -ne $byId)
    } catch {
        return $false
    }
}

function Test-LocalDevSpaceHealthy {
    if (-not (Test-PortOpen $LocalHost $LocalPort 200)) {
        return $false
    }
    $health = Get-HttpBody -url "http://${LocalHost}:${LocalPort}/healthz" -timeoutSec 2 -NoProxy
    return (Test-DevSpaceHealthzJson $health)
}

function Test-WorkerDevSpaceHealthy {
    $health = Get-HttpBody -url "$PublicProxyBase/healthz" -timeoutSec 8 -PreferIpv4
    if (-not (Test-DevSpaceHealthzJson $health)) {
        return $false
    }
    if (Get-Command Probe-DevSpacePublicMcpOrigin -ErrorAction SilentlyContinue) {
        $mcp = Probe-DevSpacePublicMcpOrigin
        return [bool]$mcp.ReachedOrigin
    }
    return $true
}

function Get-LogTail([string]$path, [int]$lines = 30) {
    if (-not (Test-Path $path)) {
        return "(log missing: $path)"
    }
    try {
        return (Get-Content -Path $path -Tail $lines -ErrorAction SilentlyContinue | Out-String).Trim()
    } catch {
        return "(failed to read log: $path)"
    }
}

function ConvertTo-Base64Url([byte[]]$Bytes) {
    return [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Get-Sha256Hex([string]$Text) {
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        return ([BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha256.Dispose()
    }
}

function ConvertTo-FormBody([hashtable]$Fields) {
    $pairs = foreach ($key in $Fields.Keys) {
        $encodedKey = [Uri]::EscapeDataString([string]$key)
        $encodedValue = [Uri]::EscapeDataString([string]$Fields[$key])
        "$encodedKey=$encodedValue"
    }
    return ($pairs -join '&')
}

function Invoke-NoProxyHttpRequest {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [string]$Method = "GET",
        [hashtable]$Headers = @{},
        [string]$Body = "",
        [string]$ContentType = "application/json"
    )

    Add-Type -AssemblyName System.Net.Http
    $handler = [System.Net.Http.HttpClientHandler]::new()
    $handler.UseProxy = $false
    $handler.AllowAutoRedirect = $false
    $client = [System.Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(20)
    $request = $null
    $response = $null
    try {
        $httpMethod = [System.Net.Http.HttpMethod]::new($Method.ToUpperInvariant())
        $request = [System.Net.Http.HttpRequestMessage]::new($httpMethod, [Uri]$Url)
        foreach ($name in $Headers.Keys) {
            [void]$request.Headers.TryAddWithoutValidation([string]$name, [string]$Headers[$name])
        }
        if ($Method -notin @("GET", "HEAD", "DELETE")) {
            $request.Content = [System.Net.Http.StringContent]::new($Body, [System.Text.Encoding]::UTF8, $ContentType)
        }

        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        $responseBody = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        $responseHeaders = @{}
        foreach ($header in $response.Headers) {
            $responseHeaders[$header.Key] = ($header.Value -join ',')
        }
        foreach ($header in $response.Content.Headers) {
            $responseHeaders[$header.Key] = ($header.Value -join ',')
        }

        return [pscustomobject]@{
            StatusCode = [int]$response.StatusCode
            Headers   = $responseHeaders
            Body      = $responseBody
        }
    } finally {
        if ($null -ne $response) { $response.Dispose() }
        if ($null -ne $request) { $request.Dispose() }
        $client.Dispose()
        $handler.Dispose()
    }
}

function ConvertFrom-McpBody([string]$Body) {
    $trimmed = $Body.Trim()
    if ([string]::IsNullOrWhiteSpace($trimmed)) {
        return $null
    }
    if ($trimmed.StartsWith("event:") -or $trimmed -match '(?m)^data:') {
        $matches = [regex]::Matches($trimmed, '(?m)^data:\s*(\{.*\})\s*$')
        if ($matches.Count -eq 0) {
            throw "Could not parse MCP SSE response: $trimmed"
        }
        $trimmed = $matches[$matches.Count - 1].Groups[1].Value
    }
    return ($trimmed | ConvertFrom-Json)
}

function Register-DevSpaceProbeClient {
    param(
        [Parameter(Mandatory = $true)][string]$LocalBaseUrl,
        [Parameter(Mandatory = $true)][string]$RedirectUri
    )

    $registration = Invoke-NoProxyHttpRequest `
        -Url "$LocalBaseUrl/register" `
        -Method "POST" `
        -Body (@{
            client_name   = "DevSpace setup inventory probe"
            redirect_uris = @($RedirectUri)
        } | ConvertTo-Json -Compress)
    if ($registration.StatusCode -notin @(200, 201)) {
        throw "DevSpace OAuth client registration failed with HTTP $($registration.StatusCode): $($registration.Body)"
    }
    $client = $registration.Body | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace($client.client_id) -or [string]::IsNullOrWhiteSpace($client.client_secret)) {
        throw "DevSpace OAuth client registration did not return client_id and client_secret."
    }
    return $client
}

function Invoke-DevSpaceProbeTokenFlow {
    param(
        [Parameter(Mandatory = $true)][string]$LocalBaseUrl,
        [Parameter(Mandatory = $true)][string]$ResourceUrl,
        [Parameter(Mandatory = $true)][string]$OwnerToken,
        [Parameter(Mandatory = $true)][string]$RedirectUri,
        [Parameter(Mandatory = $true)]$Client
    )

    $verifierBytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($verifierBytes)
    } finally {
        $rng.Dispose()
    }
    $codeVerifier = ConvertTo-Base64Url $verifierBytes
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $challengeBytes = $sha256.ComputeHash([System.Text.Encoding]::ASCII.GetBytes($codeVerifier))
    } finally {
        $sha256.Dispose()
    }
    $codeChallenge = ConvertTo-Base64Url $challengeBytes
    $state = [Guid]::NewGuid().ToString('N')

    $authorize = Invoke-NoProxyHttpRequest `
        -Url "$LocalBaseUrl/authorize" `
        -Method "POST" `
        -ContentType "application/x-www-form-urlencoded" `
        -Body (ConvertTo-FormBody @{
            owner_token           = $OwnerToken
            response_type         = "code"
            client_id             = $Client.client_id
            redirect_uri          = $RedirectUri
            code_challenge        = $codeChallenge
            code_challenge_method = "S256"
            scope                 = "devspace"
            state                 = $state
            resource              = $ResourceUrl
        })
    if ($authorize.StatusCode -notin @(302, 303)) {
        throw "DevSpace OAuth authorization failed with HTTP $($authorize.StatusCode): $($authorize.Body)"
    }
    $location = $authorize.Headers['Location']
    if ([string]::IsNullOrWhiteSpace($location)) {
        throw "DevSpace OAuth authorization did not return a redirect location."
    }
    Add-Type -AssemblyName System.Web
    $redirect = [Uri]$location
    $query = [System.Web.HttpUtility]::ParseQueryString($redirect.Query)
    if ($query['state'] -ne $state) {
        throw "DevSpace OAuth authorization returned an invalid state value."
    }
    $code = $query['code']
    if ([string]::IsNullOrWhiteSpace($code)) {
        throw "DevSpace OAuth authorization did not return an authorization code."
    }

    $token = Invoke-NoProxyHttpRequest `
        -Url "$LocalBaseUrl/token" `
        -Method "POST" `
        -ContentType "application/x-www-form-urlencoded" `
        -Body (ConvertTo-FormBody @{
            grant_type    = "authorization_code"
            code          = $code
            client_id     = $Client.client_id
            client_secret = $Client.client_secret
            redirect_uri  = $RedirectUri
            code_verifier = $codeVerifier
        })
    if ($token.StatusCode -ne 200) {
        throw "DevSpace OAuth token exchange failed with HTTP $($token.StatusCode): $($token.Body)"
    }
    $tokenBody = $token.Body | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace($tokenBody.access_token)) {
        throw "DevSpace OAuth token exchange did not return an access token."
    }
    return [string]$tokenBody.access_token
}

function New-DevSpaceProbeAccessToken {
    param(
        [Parameter(Mandatory = $true)][string]$LocalBaseUrl,
        [Parameter(Mandatory = $true)][string]$ResourceUrl,
        [Parameter(Mandatory = $true)][string]$OwnerToken
    )

    $redirectUri = "http://127.0.0.1:17676/callback"
    $resolved = Resolve-DevSpaceProbeClient `
        -ClientFile $script:probeClientFile `
        -LocalBaseUrl $LocalBaseUrl `
        -RedirectUri $redirectUri `
        -RegistrationAction { param($baseUrl, $callbackUri) Register-DevSpaceProbeClient -LocalBaseUrl $baseUrl -RedirectUri $callbackUri }
    try {
        return Invoke-DevSpaceProbeTokenFlow `
            -LocalBaseUrl $LocalBaseUrl `
            -ResourceUrl $ResourceUrl `
            -OwnerToken $OwnerToken `
            -RedirectUri $redirectUri `
            -Client $resolved.Client
    } catch {
        if (-not $resolved.Reused) {
            throw
        }
        $firstFailure = $_.Exception.Message
        Write-SetupLog "Persisted setup probe client was rejected; replacing it once. Cause: $firstFailure" "WARN"
        $replacement = Register-DevSpaceProbeClient -LocalBaseUrl $LocalBaseUrl -RedirectUri $redirectUri
        Save-PersistedDevSpaceProbeClient `
            -ClientFile $script:probeClientFile `
            -LocalBaseUrl $LocalBaseUrl `
            -RedirectUri $redirectUri `
            -Client $replacement
        try {
            return Invoke-DevSpaceProbeTokenFlow `
                -LocalBaseUrl $LocalBaseUrl `
                -ResourceUrl $ResourceUrl `
                -OwnerToken $OwnerToken `
                -RedirectUri $redirectUri `
                -Client $replacement
        } catch {
            throw "DevSpace setup probe failed with the persisted client and its single bounded replacement. First failure: $firstFailure. Replacement failure: $($_.Exception.Message)"
        }
    }
}

function Invoke-DevSpaceMcpHttpRequestWithRetry {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$Method,
        [Parameter(Mandatory = $true)][hashtable]$Headers,
        [string]$Body = "",
        [int]$RetryTimeoutSec = 0,
        [string]$Operation = "MCP request"
    )

    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $delaySeconds = 2
    $attempt = 0
    while ($true) {
        $attempt++
        try {
            $response = Invoke-NoProxyHttpRequest -Url $Url -Method $Method -Headers $Headers -Body $Body
        } catch {
            if ($RetryTimeoutSec -le 0 -or $watch.Elapsed.TotalSeconds -ge $RetryTimeoutSec) {
                throw
            }
            Write-SetupLog "$Operation transport failure on attempt $attempt; retrying: $($_.Exception.Message)" "WARN"
            $sleepSeconds = [Math]::Min($delaySeconds, [Math]::Max(1, [Math]::Floor($RetryTimeoutSec - $watch.Elapsed.TotalSeconds)))
            Start-Sleep -Seconds $sleepSeconds
            $delaySeconds = [Math]::Min(10, [Math]::Ceiling($delaySeconds * 1.6))
            continue
        }

        $retryable = $RetryTimeoutSec -gt 0 -and
            (Test-DevSpaceCloudflareUpstreamFailure -Body $response.Body -StatusCode $response.StatusCode) -and
            $watch.Elapsed.TotalSeconds -lt $RetryTimeoutSec
        if (-not $retryable) {
            return $response
        }

        Write-SetupLog "$Operation HTTP $($response.StatusCode) during trycloudflare warmup on attempt $attempt; retrying." "WARN"
        $sleepSeconds = [Math]::Min($delaySeconds, [Math]::Max(1, [Math]::Floor($RetryTimeoutSec - $watch.Elapsed.TotalSeconds)))
        Start-Sleep -Seconds $sleepSeconds
        $delaySeconds = [Math]::Min(10, [Math]::Ceiling($delaySeconds * 1.6))
    }
}

function Invoke-AuthenticatedToolsList {
    param(
        [Parameter(Mandatory = $true)][string]$BaseUrl,
        [Parameter(Mandatory = $true)][string]$AccessToken,
        [int]$RetryTimeoutSec = 0
    )

    $headers = @{
        Authorization = "Bearer $AccessToken"
        Accept        = "application/json, text/event-stream"
    }
    $initializeBodyJson = (@{
        jsonrpc = "2.0"
        id      = 1
        method  = "initialize"
        params  = @{
            protocolVersion = "2024-11-05"
            capabilities    = @{}
            clientInfo      = @{ name = "devspace-setup"; version = "1.0.0" }
        }
    } | ConvertTo-Json -Depth 8 -Compress)
    $initialize = Invoke-DevSpaceMcpHttpRequestWithRetry `
        -Url "$BaseUrl/mcp" `
        -Method "POST" `
        -Headers $headers `
        -Body $initializeBodyJson `
        -RetryTimeoutSec $RetryTimeoutSec `
        -Operation "MCP initialize at '$BaseUrl'"
    if ($initialize.StatusCode -ne 200) {
        throw "MCP initialize failed at '$BaseUrl' with HTTP $($initialize.StatusCode): $($initialize.Body)"
    }
    $initializeBody = ConvertFrom-McpBody $initialize.Body
    if ($null -eq $initializeBody.result) {
        throw "MCP initialize at '$BaseUrl' did not return a result."
    }
    $sessionId = $initialize.Headers['mcp-session-id']
    if ([string]::IsNullOrWhiteSpace($sessionId)) {
        throw "MCP initialize at '$BaseUrl' did not return mcp-session-id."
    }
    $sessionHeaders = @{
        Authorization    = "Bearer $AccessToken"
        Accept           = "application/json, text/event-stream"
        'mcp-session-id' = $sessionId
    }

    try {
        $initialized = Invoke-DevSpaceMcpHttpRequestWithRetry `
            -Url "$BaseUrl/mcp" `
            -Method "POST" `
            -Headers $sessionHeaders `
            -Body (@{
                jsonrpc = "2.0"
                method  = "notifications/initialized"
            } | ConvertTo-Json -Compress) `
            -RetryTimeoutSec $RetryTimeoutSec `
            -Operation "MCP initialized notification at '$BaseUrl'"
        if ($initialized.StatusCode -lt 200 -or $initialized.StatusCode -ge 300) {
            throw "MCP initialized notification failed at '$BaseUrl' with HTTP $($initialized.StatusCode): $($initialized.Body)"
        }

        $toolsList = Invoke-DevSpaceMcpHttpRequestWithRetry `
            -Url "$BaseUrl/mcp" `
            -Method "POST" `
            -Headers $sessionHeaders `
            -Body (@{
                jsonrpc = "2.0"
                id      = 2
                method  = "tools/list"
            } | ConvertTo-Json -Compress) `
            -RetryTimeoutSec $RetryTimeoutSec `
            -Operation "MCP tools/list at '$BaseUrl'"
        if ($toolsList.StatusCode -ne 200) {
            throw "MCP tools/list failed at '$BaseUrl' with HTTP $($toolsList.StatusCode): $($toolsList.Body)"
        }
        $toolsBody = ConvertFrom-McpBody $toolsList.Body
        if ($null -eq $toolsBody.result.tools) {
            throw "MCP tools/list at '$BaseUrl' did not return tools."
        }
        return @($toolsBody.result.tools | ForEach-Object { [string]$_.name } | Sort-Object)
    } finally {
        try {
            [void](Invoke-NoProxyHttpRequest -Url "$BaseUrl/mcp" -Method "DELETE" -Headers $sessionHeaders)
        } catch {
            Write-SetupLog "MCP probe session cleanup failed at '$BaseUrl': $_" "WARN"
        }
    }
}

function Get-DevSpaceGitIdentity {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$CliPath,
        [Parameter(Mandatory = $true)][string]$SetupScriptPath
    )

    $repository = (Resolve-Path $RepositoryRoot).Path
    $commit = ((& git -C $repository rev-parse HEAD) | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($commit)) {
        throw "Could not resolve DevSpace Git commit for '$repository'."
    }
    $branch = ((& git -C $repository rev-parse --abbrev-ref HEAD) | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "Could not resolve DevSpace Git branch for '$repository'."
    }
    $statusLines = @(& git -C $repository status --porcelain=v1 --untracked-files=all)
    if ($LASTEXITCODE -ne 0) {
        throw "Could not inspect DevSpace Git dirty state for '$repository'."
    }
    $diffLines = @(& git -C $repository -c core.safecrlf=false diff --binary --no-ext-diff HEAD --)
    if ($LASTEXITCODE -ne 0) {
        throw "Could not fingerprint DevSpace tracked changes for '$repository'."
    }
    $untrackedPaths = @(& git -C $repository ls-files --others --exclude-standard | Sort-Object)
    if ($LASTEXITCODE -ne 0) {
        throw "Could not enumerate DevSpace untracked files for '$repository'."
    }

    $fingerprintParts = @("status:") + $statusLines + @("tracked-diff:") + $diffLines + @("untracked-files:")
    foreach ($relativePath in $untrackedPaths) {
        $absolutePath = Join-Path $repository $relativePath
        if (Test-Path -LiteralPath $absolutePath -PathType Leaf) {
            $hash = (Get-FileHash -LiteralPath $absolutePath -Algorithm SHA256).Hash.ToLowerInvariant()
            $fingerprintParts += "$relativePath`t$hash"
        } else {
            $fingerprintParts += "$relativePath`t(non-regular-or-missing)"
        }
    }

    return [pscustomobject]@{
        repository                  = $repository
        commit                      = $commit
        branch                      = $branch
        dirty                       = ($statusLines.Count -gt 0)
        dirtyFingerprintSha256      = Get-Sha256Hex ($fingerprintParts -join "`n")
        cliSha256                   = (Get-FileHash -LiteralPath $CliPath -Algorithm SHA256).Hash.ToLowerInvariant()
        setupScriptSha256           = (Get-FileHash -LiteralPath $SetupScriptPath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}

function Save-RuntimeState {
    param(
        [int]$DevSpacePid,
        [int]$CloudflaredPid,
        [string]$TunnelUrl,
        [string]$TunnelHost,
        [Parameter(Mandatory = $true)]$GitIdentity,
        [string[]]$LocalTools = @(),
        [string[]]$PublicTools = @()
    )
    $dir = Split-Path -Parent $script:runtimePidFile
    if (!(Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $state = @{
        devspacePid     = $DevSpacePid
        cloudflaredPid  = $CloudflaredPid
        tunnelUrl       = $TunnelUrl
        tunnelHost      = $TunnelHost
        publicBaseUrl   = $PublicProxyBase
        startedAt       = (Get-Date).ToString("o")
        stdoutLog       = $script:devspaceStdoutLog
        stderrLog       = $script:devspaceStderrLog
        cloudflaredLog  = $script:cloudflaredLogFile
        source          = @{
            repository             = $GitIdentity.repository
            commit                 = $GitIdentity.commit
            branch                 = $GitIdentity.branch
            dirty                  = [bool]$GitIdentity.dirty
            dirtyFingerprintSha256 = $GitIdentity.dirtyFingerprintSha256
            cliSha256              = $GitIdentity.cliSha256
            setupScriptSha256      = $GitIdentity.setupScriptSha256
        }
        toolInventory   = @{
            expected   = @($ExpectedTools)
            local      = @($LocalTools)
            public     = @($PublicTools)
            verifiedAt = (Get-Date).ToString("o")
        }
    }
    ($state | ConvertTo-Json -Depth 8) | Set-Content -Path $script:runtimePidFile -Encoding UTF8
    Write-SetupLog "Wrote runtime state with source and tool fingerprints: $script:runtimePidFile"
}

function Stop-DevSpaceRuntime {
    Write-SetupLog "Stopping DevSpace runtime..."
    $pids = @()
    if (Test-Path $script:runtimePidFile) {
        try {
            $state = Get-Content $script:runtimePidFile -Raw | ConvertFrom-Json
            if ($state.devspacePid) { $pids += [int]$state.devspacePid }
            if ($state.cloudflaredPid) { $pids += [int]$state.cloudflaredPid }
        } catch {}
    }
    foreach ($procId in $pids) {
        try {
            Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
            Write-SetupLog "  Stopped PID $procId"
        } catch {}
    }
    # Port-based sweep for orphans
    foreach ($port in @($LocalPort, $DeviceProofPort)) {
        try {
            Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
                Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
                Write-SetupLog "  Freed port $port (PID $($_.OwningProcess))"
            }
        } catch {}
    }
    Get-Process -Name "cloudflared", "ngrok" -ErrorAction SilentlyContinue | ForEach-Object {
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path $script:runtimePidFile) {
        Remove-Item $script:runtimePidFile -Force -ErrorAction SilentlyContinue
    }
    Write-SetupLog "Stop complete."
}

function Find-DevSpaceServeProcess {
    $rememberedPid = 0
    $state = Read-DevSpaceRuntimeState
    if ($null -ne $state -and $state.devspacePid) {
        $rememberedPid = [int]$state.devspacePid
    }
    $listenerPid = 0
    try {
        $listen = @(Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue)
        if ($listen.Count -gt 0 -and $listen[0].OwningProcess) {
            $listenerPid = [int]$listen[0].OwningProcess
        }
    } catch {
    }

    if ($listenerPid -gt 0) {
        $owner = Get-DevSpaceProcessRecordByPid -ProcessId $listenerPid -ExpectedName "node.exe"
        if (Test-DevSpaceOriginRecord -Record $owner -ListenerPid $listenerPid -RememberedPid $rememberedPid) {
            return $owner
        }
    }

    if ($rememberedPid -gt 0) {
        $remembered = Get-DevSpaceProcessRecordByPid -ProcessId $rememberedPid -ExpectedName "node.exe"
        if (Test-DevSpaceOriginRecord -Record $remembered -ListenerPid $listenerPid -RememberedPid $rememberedPid) {
            return $remembered
        }
    }

    $nodeProcs = @(Get-Process -Name "node" -ErrorAction SilentlyContinue)
    foreach ($proc in $nodeProcs) {
        $record = [pscustomobject]@{
            Name        = "node.exe"
            ProcessId   = $proc.Id
            CommandLine = ""
        }
        if (Test-DevSpaceOriginRecord -Record $record -ListenerPid $listenerPid -RememberedPid $rememberedPid) {
            return $record
        }
    }
    return $null
}

function Stop-DevSpaceRelatedProcesses {
    Write-Host "Stopping existing cloudflared, ngrok, and any process holding DevSpace ports..."

    Get-Process -Name "cloudflared", "ngrok" -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Host "  Stopping PID $($_.Id): $($_.ProcessName)"
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        if (Get-Process -Id $_.Id -ErrorAction SilentlyContinue) {
            Write-SetupLog "PID $($_.Id) ($($_.ProcessName)) survived Stop-Process; it may be SYSTEM-protected." "WARN"
        }
    }

    # Always free listeners on MCP / device-proof ports (catches unknown binaries).
    foreach ($port in @($LocalPort, $DeviceProofPort)) {
        try {
            $listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
            foreach ($listener in $listeners) {
                $owner = $listener.OwningProcess
                if ($owner -and $owner -ne $PID) {
                    Write-Host "  Freeing port $port (PID $owner)"
                    Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
                }
            }
        } catch {
        }
    }

    Start-Sleep -Milliseconds 800

    if (Test-PortOpen $LocalHost $LocalPort 200) {
        throw "Port $LocalPort is still in use after cleanup. Close the process using it and retry."
    }
    if (Test-PortOpen $LocalHost $DeviceProofPort 200) {
        throw "Port $DeviceProofPort is still in use after cleanup. Close the process using it and retry."
    }
}

function Test-CloudflaredEdgeRegistered([string]$logPath) {
    if (-not (Test-Path $logPath)) {
        return $false
    }
    try {
        $logContent = Get-Content $logPath -Raw -ErrorAction SilentlyContinue
        if (-not $logContent) {
            return $false
        }
        return $logContent -match 'Registered tunnel connection'
    } catch {
        return $false
    }
}

function Invoke-CurlText {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$CurlArgs
    )

    # Native curl stderr (timeouts, resolve failures) must not become terminating
    # errors under $ErrorActionPreference = "Stop".
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $raw = & curl.exe @CurlArgs 2>&1
        $exitCode = $LASTEXITCODE
        $text = @(
            $raw | ForEach-Object {
                if ($_ -is [System.Management.Automation.ErrorRecord]) {
                    $_.Exception.Message
                } else {
                    "$_"
                }
            }
        ) -join "`n"
        return [pscustomobject]@{
            ExitCode = $exitCode
            Text     = $text.Trim()
        }
    } finally {
        $ErrorActionPreference = $previousEap
    }
}

function Get-HttpBody([string]$url, [int]$timeoutSec = 5, [hashtable]$headers = $null, [switch]$PreferIpv4, [switch]$NoProxy) {
    $headerArgs = @()
    if ($null -ne $headers) {
        foreach ($key in $headers.Keys) {
            $headerArgs += @("-H", "${key}: $($headers[$key])")
        }
    }

    # -s silent body; omit -S so transport errors stay non-noisy.
    # --connect-timeout bounds DNS/TCP; --max-time bounds the whole transfer.
    $connectTimeout = [Math]::Max(2, [Math]::Min(10, $timeoutSec))
    $curlArgs = @(
        "-s",
        "--connect-timeout", "$connectTimeout",
        "--max-time", "$timeoutSec"
    )
    if ($PreferIpv4) {
        $curlArgs += "-4"
    }
    # Bypass Clash/session HTTP_PROXY for Worker endpoints (default when URL is our proxy).
    if ($NoProxy -or $url -like "$PublicProxyBase*") {
        $curlArgs += @("--noproxy", "*")
    }
    $curlArgs = $curlArgs + $headerArgs + @($url)

    $result = Invoke-CurlText -CurlArgs $curlArgs
    if ($result.ExitCode -ne 0 -and [string]::IsNullOrWhiteSpace($result.Text)) {
        return "curl-exit-$($result.ExitCode)"
    }
    return $result.Text
}

function Register-TunnelWithProxy([string]$tunnelUrl, [string]$authToken, [string]$detectedProxy) {
    $proxyUrl = "$PublicProxyBase/set-tunnel"
    Write-SetupLog "Registering tunnel URL with Cloudflare Worker proxy..."
    Write-SetupLog "  Upstream: $tunnelUrl"
    Write-SetupLog "  Endpoint: $proxyUrl"
    Write-SetupLog "  Setup log: $script:setupLogFile"

    # IMPORTANT: session HTTP(S)_PROXY (Clash) often breaks Worker POSTs or hangs them.
    # Always try a true direct call first with --noproxy "*".
    $attempts = @(
        [pscustomobject]@{
            Name = "direct-noproxy"
            Args = @(
                "-s", "-S", "-4",
                "--noproxy", "*",
                "-X", "POST", $proxyUrl,
                "-H", "Content-Type: text/plain",
                "-H", "X-Auth-Token: $authToken",
                "--data-binary", $tunnelUrl,
                "--connect-timeout", "8",
                "--max-time", "15",
                "-w", "\n__CURL_HTTP_CODE__:%{http_code}"
            )
        }
    )

    if ($null -ne $detectedProxy -and $detectedProxy -ne "") {
        $attempts += [pscustomobject]@{
            Name = "via-local-proxy"
            Args = @(
                "-s", "-S", "-4",
                "-x", $detectedProxy,
                "-X", "POST", $proxyUrl,
                "-H", "Content-Type: text/plain",
                "-H", "X-Auth-Token: $authToken",
                "--data-binary", $tunnelUrl,
                "--connect-timeout", "8",
                "--max-time", "15",
                "-w", "\n__CURL_HTTP_CODE__:%{http_code}"
            )
        }
    }

    $lastDetail = ""
    foreach ($attempt in $attempts) {
        Write-SetupLog "  Trying registration ($($attempt.Name))..."
        $result = Invoke-CurlText -CurlArgs $attempt.Args
        $raw = $result.Text
        $httpCode = ""
        $body = $raw
        if ($raw -match '(?s)(.*)\n__CURL_HTTP_CODE__:(\d+)\s*$') {
            $body = $Matches[1].Trim()
            $httpCode = $Matches[2]
        }
        $lastDetail = "mode=$($attempt.Name); curlExit=$($result.ExitCode); http=$httpCode; body=$body"
        Write-SetupLog "  Result: $lastDetail"

        if ($body.Trim() -eq "OK") {
            Write-SetupLog "Successfully registered tunnel URL ($($attempt.Name))."
            return
        }
    }

    # Fallback: Invoke-WebRequest direct (bypasses curl env-proxy quirks).
    Write-SetupLog "  Trying registration (Invoke-WebRequest direct)..."
    try {
        $prevProxy = [System.Net.WebRequest]::DefaultWebProxy
        [System.Net.WebRequest]::DefaultWebProxy = $null
        $headers = @{ "X-Auth-Token" = $authToken }
        $resp = Invoke-WebRequest -Uri $proxyUrl -Method Post -Body $tunnelUrl -ContentType "text/plain" -Headers $headers -UseBasicParsing -TimeoutSec 15
        $body = ($resp.Content | Out-String).Trim()
        $lastDetail = "mode=iwr-direct; status=$($resp.StatusCode); body=$body"
        Write-SetupLog "  Result: $lastDetail"
        if ($body -eq "OK" -or ($resp.StatusCode -eq 200 -and $body -match '^\s*OK\s*$')) {
            Write-SetupLog "Successfully registered tunnel URL (Invoke-WebRequest)."
            return
        }
    } catch {
        $lastDetail = "mode=iwr-direct; error=$($_.Exception.Message)"
        Write-SetupLog "  Result: $lastDetail" "WARN"
    } finally {
        if ($null -ne $prevProxy) {
            [System.Net.WebRequest]::DefaultWebProxy = $prevProxy
        }
    }

    throw "Failed to register tunnel URL with Worker proxy. Last result: $lastDetail"
}

function Probe-DevSpacePublicMcpOrigin {
    try {
        $response = Invoke-NoProxyHttpRequest `
            -Url "$PublicProxyBase/mcp" `
            -Method "POST" `
            -Headers @{ Accept = "application/json, text/event-stream" } `
            -Body '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"devspace-setup-ready","version":"1.0.0"}}}'
        return [pscustomobject]@{
            StatusCode    = [int]$response.StatusCode
            Body          = [string]$response.Body
            ReachedOrigin = [bool](Test-DevSpacePublicMcpReachedOrigin -Body $response.Body -StatusCode $response.StatusCode)
        }
    } catch {
        return [pscustomobject]@{
            StatusCode    = 0
            Body          = $_.Exception.Message
            ReachedOrigin = $false
        }
    }
}

function Test-ProxyUsesTunnel([string]$expectedTunnelHost, [int]$timeoutSec = 180) {
    $probeUrl = "$PublicProxyBase/healthz"
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $attempt = 0
    $delaySeconds = 2

    while ($watch.Elapsed.TotalSeconds -lt $timeoutSec) {
        $attempt++
        $remainingSeconds = [Math]::Max(2, [Math]::Ceiling($timeoutSec - $watch.Elapsed.TotalSeconds))
        $probeTimeout = [Math]::Min(15, $remainingSeconds)
        $body = Get-HttpBody -url $probeUrl -timeoutSec $probeTimeout -PreferIpv4
        $observation = Get-DevSpaceProxyHealthObservation -Body $body -ExpectedTunnelHost $expectedTunnelHost
        $elapsed = [Math]::Round($watch.Elapsed.TotalSeconds, 1)

        if ($observation.Kind -eq "healthy") {
            $mcp = Probe-DevSpacePublicMcpOrigin
            if ($mcp.ReachedOrigin) {
                Write-Host "Proxy healthz and POST /mcp reached origin (attempt $attempt, ${elapsed}s): healthz=$body mcp=$($mcp.StatusCode)"
                Write-SetupLog "Public path ready after ${elapsed}s: healthz JSON ok, POST /mcp HTTP $($mcp.StatusCode) reached origin."
                return $true
            }
            $mcpPreview = if ($mcp.Body.Length -gt 120) { $mcp.Body.Substring(0, 120) + "..." } else { $mcp.Body }
            Write-Warning "Proxy /healthz is DevSpace JSON, but POST /mcp has not reached origin yet [attempt $attempt, ${elapsed}s]. HTTP $($mcp.StatusCode): $mcpPreview"
            Write-SetupLog "Waiting for trycloudflare DNS: healthz JSON ok, POST /mcp HTTP $($mcp.StatusCode) not origin yet." "WARN"
        } else {
            switch ($observation.Kind) {
                "expected-upstream-not-ready" {
                    $title = if ($observation.Title) { $observation.Title } else { "(no title)" }
                    Write-Warning "Proxy already points at expected tunnel '$expectedTunnelHost', but Cloudflare origin DNS/reachability is not ready yet [attempt $attempt, ${elapsed}s]. Waiting without re-registering. Title: $title"
                }
                "stale-upstream" {
                    $title = if ($observation.Title) { $observation.Title } else { "(no title)" }
                    Write-Warning "Proxy still reports stale tunnel host '$($observation.SeenHost)' (expected '$expectedTunnelHost') [attempt $attempt, ${elapsed}s]. Waiting for the successful /set-tunnel update to converge. Title: $title"
                }
                "invalid-host" {
                    Write-Warning "DevSpace rejected Host '$($observation.SeenHost)' via proxy [attempt $attempt, ${elapsed}s]. Allowlist may be stale."
                }
                default {
                    $preview = if ($body.Length -gt 160) { $body.Substring(0, 160) + "..." } else { $body }
                    Write-Warning "Proxy healthz not ready [attempt $attempt, ${elapsed}s]: $preview"
                }
            }
        }

        $remainingAfterProbe = $timeoutSec - $watch.Elapsed.TotalSeconds
        if ($remainingAfterProbe -le 0) {
            break
        }
        $sleepSeconds = [Math]::Min($delaySeconds, [Math]::Max(1, [Math]::Floor($remainingAfterProbe)))
        Start-Sleep -Seconds $sleepSeconds
        $delaySeconds = [Math]::Min(10, [Math]::Ceiling($delaySeconds * 1.6))
    }

    Write-Warning "Proxy did not become healthy for expected tunnel '$expectedTunnelHost' within ${timeoutSec}s."
    return $false
}

function Start-DevSpaceServer([string]$devspaceCli, [string]$tunnelHost) {
    $proxyHost = ([System.Uri]$PublicProxyBase).Host

    $configDir = Join-Path $env:USERPROFILE ".devspace"
    $config = @{
        host          = $LocalHost
        port          = $LocalPort
        allowedRoots  = @($AllowedRoots)
        publicBaseUrl = $PublicProxyBase
        allowedHosts  = @($proxyHost, "*.trycloudflare.com", $tunnelHost, "localhost", "127.0.0.1")
    }
    $configJson = $config | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText((Join-Path $configDir "config.json"), $configJson + "`n")
    Write-Host "Updated $(Join-Path $configDir 'config.json')"

    $env:DEVSPACE_PUBLIC_BASE_URL = $PublicProxyBase
    # No space after commas; parser trims, but keep the value clean.
    $env:DEVSPACE_ALLOWED_HOSTS = "$proxyHost,*.trycloudflare.com,$tunnelHost,localhost,127.0.0.1"
    $env:DEVSPACE_ALLOWED_ROOTS = $AllowedRootsEnv
    $env:DEVSPACE_TRUST_PROXY = "true"
    $env:DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS = "chatgpt.com,claude.ai,perplexity.ai,*.perplexity.ai,www.perplexity.com,enterprise.perplexity.com,n.perplexity.com,staging.perplexity.com,chatshare.xyz,*.chatshare.xyz,localhost,127.0.0.1"
    $env:DEVSPACE_OAUTH_REDIRECT_URI_ALIASES = "https://chatgpt.com/connector/oauth/=https://chatshare.xyz/connector/oauth/"
    $env:DEVSPACE_DEVICE_AUTH = "true"
    $env:DEVSPACE_DEVICE_AUTH_REQUIRED = "false"
    $env:DEVSPACE_DEVICE_AUTH_LOOPBACK_PORT = "$DeviceProofPort"
    $env:DEVSPACE_DEVICE_AUTH_EXTENSION_ID = "aaoelopmdnhifffjefciagfmhjanbaoc"
    $env:DEVSPACE_DEVICE_AUTH_ALLOWED_REDIRECT_PREFIXES = "https://chatshare.xyz/connector/oauth/,https://chatshare.xyz/connector_platform_oauth_redirect"
    $env:GIT_TERMINAL_PROMPT = "0"
    $env:GIT_EDITOR = "true"
    $env:GIT_ASKPASS = "true"
    $env:SSH_ASKPASS = ""
    $env:GCM_INTERACTIVE = "never"

    Write-SetupLog "Starting DevSpace server (detached background)..."
    $script:devspaceStdoutLog = Join-Path $env:TEMP "devspace_serve_stdout.log"
    $script:devspaceStderrLog = Join-Path $env:TEMP "devspace_serve_stderr.log"
    foreach ($logPath in @($script:devspaceStdoutLog, $script:devspaceStderrLog)) {
        if (Test-Path $logPath) {
            Remove-Item $logPath -Force -ErrorAction SilentlyContinue
        }
    }

    # Launch via .cmd + WMI Create so Node is outside this PowerShell job object.
    # Job-affined children are force-killed with ExitCode=null (console/job teardown).
    $launcherCmd = Join-Path $env:TEMP "devspace_serve_launch.cmd"
    $nodeExe = (Get-Command node -ErrorAction Stop).Source
    $cmdLines = @(
        "@echo off"
        "setlocal"
        "cd /d `"$PSScriptRoot`""
        "set DEVSPACE_PUBLIC_BASE_URL=$($env:DEVSPACE_PUBLIC_BASE_URL)"
        "set DEVSPACE_ALLOWED_HOSTS=$($env:DEVSPACE_ALLOWED_HOSTS)"
        "set DEVSPACE_ALLOWED_ROOTS=$($env:DEVSPACE_ALLOWED_ROOTS)"
        "set DEVSPACE_TRUST_PROXY=$($env:DEVSPACE_TRUST_PROXY)"
        "set DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS=$($env:DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS)"
        "set DEVSPACE_OAUTH_REDIRECT_URI_ALIASES=$($env:DEVSPACE_OAUTH_REDIRECT_URI_ALIASES)"
        "set DEVSPACE_DEVICE_AUTH=$($env:DEVSPACE_DEVICE_AUTH)"
        "set DEVSPACE_DEVICE_AUTH_REQUIRED=$($env:DEVSPACE_DEVICE_AUTH_REQUIRED)"
        "set DEVSPACE_DEVICE_AUTH_LOOPBACK_PORT=$($env:DEVSPACE_DEVICE_AUTH_LOOPBACK_PORT)"
        "set DEVSPACE_DEVICE_AUTH_EXTENSION_ID=$($env:DEVSPACE_DEVICE_AUTH_EXTENSION_ID)"
        "set DEVSPACE_DEVICE_AUTH_ALLOWED_REDIRECT_PREFIXES=$($env:DEVSPACE_DEVICE_AUTH_ALLOWED_REDIRECT_PREFIXES)"
        "set GIT_TERMINAL_PROMPT=0"
        "set GIT_EDITOR=true"
        "set GIT_ASKPASS=true"
        "set GCM_INTERACTIVE=never"
        "`"$nodeExe`" `"$devspaceCli`" serve >>`"$($script:devspaceStdoutLog)`" 2>>`"$($script:devspaceStderrLog)`""
    )
    Set-Content -Path $launcherCmd -Value ($cmdLines -join "`r`n") -Encoding ASCII

    $create = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine      = "cmd.exe /c `"$launcherCmd`""
        CurrentDirectory = $PSScriptRoot
    }
    if ($create.ReturnValue -ne 0 -or -not $create.ProcessId) {
        throw "Failed to start DevSpace launcher via WMI (ReturnValue=$($create.ReturnValue))."
    }
    Write-SetupLog "Launcher PID=$($create.ProcessId) ($launcherCmd)"

    $proc = $null
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 400
        $found = Find-DevSpaceServeProcess
        if ($found) {
            $proc = Get-Process -Id $found.ProcessId -ErrorAction SilentlyContinue
            if ($proc) { break }
        }
    }
    if ($null -eq $proc) {
        Write-SetupLog "WMI launcher did not yield serve PID; falling back to Start-Process." "WARN"
        $proc = Start-Process -FilePath $nodeExe `
            -ArgumentList @($devspaceCli, "serve") `
            -WorkingDirectory $PSScriptRoot `
            -NoNewWindow `
            -RedirectStandardOutput $script:devspaceStdoutLog `
            -RedirectStandardError $script:devspaceStderrLog `
            -PassThru
    }
    if ($null -eq $proc) {
        throw "DevSpace failed to start: no node serve process found."
    }
    Write-SetupLog "DevSpace started PID=$($proc.Id); logs: $script:devspaceStdoutLog | $script:devspaceStderrLog"

    # Wait until local MCP port is listening and healthz works.
    $ready = $false
    for ($i = 0; $i -lt 45; $i++) {
        Start-Sleep -Seconds 1
        if (-not (Test-ManagedProcessAlive $proc)) {
            $tail = Get-LogTail $script:devspaceStderrLog 40
            throw "DevSpace exited during startup. PID=$($proc.Id); ExitCode=$(Get-SafeExitCode $proc).`n--- stderr tail ---`n$tail"
        }
        if (-not (Test-PortOpen $LocalHost $LocalPort 200)) {
            continue
        }

        $health = Get-HttpBody -url "http://${LocalHost}:${LocalPort}/healthz" -timeoutSec 2 -NoProxy
        if (Test-DevSpaceHealthzJson $health) {
            # Confirm tunnel host is allowed (this is what cloudflared will send).
            $withTunnelHost = Get-HttpBody -url "http://${LocalHost}:${LocalPort}/healthz" -timeoutSec 2 -NoProxy -headers @{ Host = $tunnelHost }
            if ($withTunnelHost -match 'Invalid Host') {
                throw "Local DevSpace is listening but rejects Host '$tunnelHost'. Check DEVSPACE_ALLOWED_HOSTS / config.json."
            }
            if (Test-DevSpaceHealthzJson $withTunnelHost) {
                $ready = $true
                break
            }
            if ($withTunnelHost -notmatch 'Invalid Host') {
                $ready = $true
                break
            }
        }
    }

    if (-not $ready) {
        $tail = Get-LogTail $script:devspaceStderrLog 40
        throw "DevSpace did not become healthy on http://${LocalHost}:${LocalPort}/healthz within timeout.`n--- stderr tail ---`n$tail"
    }

    Write-SetupLog "Local DevSpace is healthy on port $LocalPort (tunnel host allowlisted)."
    return $proc
}

function Stop-TrackedProcesses {
    foreach ($process in @($script:devspaceProcess, $script:cloudflaredProcess)) {
        if ($null -eq $process) { continue }
        try {
            $process.Refresh()
            if (-not $process.HasExited) {
                Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            }
        } catch {
        }
    }
}

function Read-DevSpaceRuntimeState {
    if (-not (Test-Path -LiteralPath $script:runtimePidFile -PathType Leaf)) {
        return $null
    }
    try {
        return Get-Content -LiteralPath $script:runtimePidFile -Raw | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Test-DevSpaceQuickTunnelAlive {
    if ($null -ne $script:cloudflaredProcess -and (Test-ManagedProcessAlive $script:cloudflaredProcess)) {
        return $true
    }
    $rememberedPid = 0
    $state = Read-DevSpaceRuntimeState
    if ($null -ne $state -and $state.cloudflaredPid) {
        $rememberedPid = [int]$state.cloudflaredPid
    }
    $cloudflaredProcs = @(Get-Process -Name "cloudflared" -ErrorAction SilentlyContinue)
    foreach ($proc in $cloudflaredProcs) {
        $record = [pscustomobject]@{
            Name        = "cloudflared.exe"
            ProcessId   = $proc.Id
            CommandLine = ""
        }
        if (-not (Test-DevSpaceCloudflaredRecord -Record $record -LocalPort $LocalPort -RememberedPid $rememberedPid)) {
            continue
        }
        $script:cloudflaredProcess = $proc
        if ($null -ne $script:cloudflaredProcess) {
            return $true
        }
    }

    # If custody is stale but there is exactly one cloudflared process, accept it
    # only when a known DevSpace tunnel log yields a URL that reaches this origin.
    if ($cloudflaredProcs.Count -eq 1) {
        $candidates = @(Get-DevSpaceQuickTunnelUrlCandidatesFromLogFiles -LogFiles @(
            Get-DevSpaceKnownCloudflaredLogFiles -RuntimeFile $script:runtimePidFile -ScriptLogFile $script:cloudflaredLogFile
        ))
        foreach ($candidate in $candidates) {
            if (Test-DevSpaceQuickTunnelUrlHealthy -TunnelUrl ([string]$candidate.TunnelUrl)) {
                $script:cloudflaredProcess = $cloudflaredProcs[0]
                $script:cloudflaredLogFile = [string]$candidate.LogFile
                Write-SetupLog "Recovered single live cloudflared PID=$($script:cloudflaredProcess.Id) from validated tunnel log $($candidate.LogFile)." "WARN"
                return $true
            }
        }
    }
    return $false
}

function Test-DevSpaceQuickTunnelUrlHealthy {
    param([Parameter(Mandatory = $true)][string]$TunnelUrl)

    try {
        $uri = [System.Uri]$TunnelUrl
    } catch {
        return $false
    }
    if ($uri.Scheme -ne "https" -or $uri.Host -notmatch '(?i)^[a-z0-9-]+\.trycloudflare\.com$') {
        return $false
    }
    $healthUrl = $TunnelUrl.TrimEnd('/') + "/healthz"
    for ($attempt = 1; $attempt -le 2; $attempt++) {
        $body = Get-HttpBody -url $healthUrl -timeoutSec 6 -PreferIpv4 -NoProxy
        if (Test-DevSpaceHealthzJson $body) {
            return $true
        }
        if ($attempt -lt 2) { Start-Sleep -Seconds 2 }
    }
    return $false
}

function Get-LiveQuickTunnelUrlFromCloudflared {
    if ($null -eq $script:cloudflaredProcess -or -not (Test-ManagedProcessAlive $script:cloudflaredProcess)) {
        [void](Test-DevSpaceQuickTunnelAlive)
    }
    if ($null -eq $script:cloudflaredProcess -or -not (Test-ManagedProcessAlive $script:cloudflaredProcess)) {
        return $null
    }

    $candidates = @(Get-DevSpaceQuickTunnelUrlCandidatesFromLogFiles -LogFiles @(
        Get-DevSpaceKnownCloudflaredLogFiles `
            -RuntimeFile $script:runtimePidFile `
            -ScriptLogFile $script:cloudflaredLogFile
    ))
    foreach ($candidate in $candidates) {
        if (Test-DevSpaceQuickTunnelUrlHealthy -TunnelUrl ([string]$candidate.TunnelUrl)) {
            $script:cloudflaredLogFile = [string]$candidate.LogFile
            return [string]$candidate.TunnelUrl
        }
    }
    return $null
}

function Get-CurrentQuickTunnelUrl {
    # A live cloudflared process and its own logfile outrank persisted custody.
    # This prevents a stale runtime.json from restoring a dead quick-tunnel URL.
    $liveUrl = Get-LiveQuickTunnelUrlFromCloudflared
    if (-not [string]::IsNullOrWhiteSpace($liveUrl)) {
        return $liveUrl
    }
    if ($script:cloudflaredProcess -and (Test-ManagedProcessAlive $script:cloudflaredProcess)) {
        Write-SetupLog "Live cloudflared PID=$($script:cloudflaredProcess.Id) has no recoverable live tunnel URL; refusing persisted tunnel custody." "WARN"
        return $null
    }

    # A supervisor can remint cloudflared without updating runtime.json. Recover
    # from known logs even when the current PID cannot be bound, but only accept
    # URLs that independently reach a DevSpace /healthz endpoint.
    $candidates = @(Get-DevSpaceQuickTunnelUrlCandidatesFromLogFiles -LogFiles @(
        Get-DevSpaceKnownCloudflaredLogFiles `
            -RuntimeFile $script:runtimePidFile `
            -ScriptLogFile $script:cloudflaredLogFile
    ))
    foreach ($candidate in $candidates) {
        if (Test-DevSpaceQuickTunnelUrlHealthy -TunnelUrl ([string]$candidate.TunnelUrl)) {
            $script:cloudflaredLogFile = [string]$candidate.LogFile
            return [string]$candidate.TunnelUrl
        }
    }

    $state = Read-DevSpaceRuntimeState
    if ($null -ne $state -and -not [string]::IsNullOrWhiteSpace([string]$state.tunnelUrl)) {
        $rememberedUrl = [string]$state.tunnelUrl
        if (Test-DevSpaceQuickTunnelUrlHealthy -TunnelUrl $rememberedUrl) {
            return $rememberedUrl
        }
        Write-SetupLog "Refusing stale runtime tunnel custody because direct /healthz validation failed: $rememberedUrl" "WARN"
    }
    return $null
}

function Update-CurrentQuickTunnelCustody {
    param([Parameter(Mandatory = $true)][string]$TunnelUrl)

    $tunnelHost = ([System.Uri]$TunnelUrl).Host
    if ($null -eq $script:cloudflaredProcess -or -not (Test-ManagedProcessAlive $script:cloudflaredProcess)) {
        [void](Test-DevSpaceQuickTunnelAlive)
    }
    $cloudflaredPid = if ($script:cloudflaredProcess) { [int]$script:cloudflaredProcess.Id } else { 0 }
    $devspacePid = if ($script:devspaceProcess -and (Test-ManagedProcessAlive $script:devspaceProcess)) { [int]$script:devspaceProcess.Id } else { -1 }

    Update-DevSpaceTunnelCustodyFile `
        -RuntimeFile $script:runtimePidFile `
        -TunnelUrl $TunnelUrl `
        -TunnelHost $tunnelHost `
        -CloudflaredPid $cloudflaredPid `
        -CloudflaredLog $script:cloudflaredLogFile `
        -DevSpacePid $devspacePid `
        -PublicBaseUrl $PublicProxyBase | Out-Null
    Write-SetupLog "Persisted quick-tunnel custody immediately: pid=$cloudflaredPid host=$tunnelHost log=$script:cloudflaredLogFile"
}

function Stop-DevSpaceCloudflaredOnly {
    Write-SetupLog "Stopping cloudflared only; leaving the DevSpace origin running."
    $targets = New-Object 'System.Collections.Generic.HashSet[int]'
    if ($null -ne $script:cloudflaredProcess) {
        [void]$targets.Add([int]$script:cloudflaredProcess.Id)
    }
    $state = Read-DevSpaceRuntimeState
    if ($null -ne $state -and $state.cloudflaredPid) {
        [void]$targets.Add([int]$state.cloudflaredPid)
    }
    Get-Process -Name "cloudflared" -ErrorAction SilentlyContinue | ForEach-Object {
        [void]$targets.Add([int]$_.Id)
    }
    foreach ($procId in $targets) {
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        if (Get-Process -Id $procId -ErrorAction SilentlyContinue) {
            Write-SetupLog "  cloudflared PID $procId survived Stop-Process (likely SYSTEM-protected)." "WARN"
        } else {
            Write-SetupLog "  Stopped cloudflared PID $procId"
        }
    }
    $script:cloudflaredProcess = $null
    Start-Sleep -Seconds 1
}

function Start-CloudflaredQuickTunnel {
    # Protected / still-running tunnels cannot be replaced by this unelevated
    # launcher. Reuse their live logfile URL rather than trusting stale custody.
    if (Test-DevSpaceQuickTunnelAlive) {
        $existing = Get-CurrentQuickTunnelUrl
        if (-not [string]::IsNullOrWhiteSpace($existing)) {
            $alivePid = if ($script:cloudflaredProcess) { $script:cloudflaredProcess.Id } else { "n/a" }
            Write-SetupLog "Reusing live cloudflared PID=$alivePid url=$existing"
            Update-CurrentQuickTunnelCustody -TunnelUrl $existing
            Write-Host "Reusing existing Cloudflare Quick Tunnel: $existing"
            return $existing
        }
        $alivePid = if ($script:cloudflaredProcess) { $script:cloudflaredProcess.Id } else { "n/a" }
        throw "Live cloudflared PID=$alivePid exists, but its current quick-tunnel URL cannot be recovered safely. Refusing to trust stale runtime custody or remint over a live tunnel."
    }

    # Unique --logfile so a leftover cloudflared holding the legacy log cannot
    # block a remint, and so we never parse a stale URL from a previous run.
    $logFile = Join-Path $env:TEMP ("cloudflared_tunnel_{0}_{1}.log" -f $PID, [guid]::NewGuid().ToString("N"))
    $script:cloudflaredLogFile = $logFile

    Write-Host "Starting Cloudflare Quick Tunnel..."
    $cfExe = (Get-Command cloudflared -ErrorAction Stop).Source
    $commandLine = Get-DevSpaceCloudflaredLaunchCommand `
        -Executable $cfExe `
        -LocalHost $LocalHost `
        -LocalPort $LocalPort `
        -LogFile $logFile
    # WMI Create runs outside this PowerShell job object. Start-Process -NoNewWindow
    # children are force-killed with ExitCode=null (console/job teardown).
    $cfCreate = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine      = $commandLine
        CurrentDirectory = $PSScriptRoot
    }
    if ($cfCreate.ReturnValue -ne 0 -or -not $cfCreate.ProcessId) {
        throw "cloudflared failed to start via WMI (ReturnValue=$($cfCreate.ReturnValue)). Job-affined Start-Process is not used because it is force-killed with ExitCode=null."
    }
    Write-SetupLog "cloudflared WMI PID=$($cfCreate.ProcessId) logfile=$logFile"
    $script:cloudflaredProcess = Get-Process -Id $cfCreate.ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $script:cloudflaredProcess) {
        throw "cloudflared WMI PID $($cfCreate.ProcessId) started but no process handle was returned."
    }

    $tunnelUrl = $null
    Write-Host "Waiting for tunnel URL..." -NoNewline
    for ($i = 0; $i -lt 45; $i++) {
        Start-Sleep -Seconds 1
        Write-Host "." -NoNewline
        if (-not (Test-ManagedProcessAlive $script:cloudflaredProcess)) {
            $tail = Get-LogTail $logFile 40
            throw "cloudflared exited before publishing a URL. ExitCode=$(Get-SafeExitCode $script:cloudflaredProcess). See $logFile`n--- log tail ---`n$tail"
        }
        if (Test-Path -LiteralPath $logFile) {
            $logContent = Get-Content -LiteralPath $logFile -Raw -ErrorAction SilentlyContinue
            $tunnelUrl = Get-DevSpaceQuickTunnelUrlFromLogText $logContent
            if ($tunnelUrl) {
                Write-Host "`nFound Tunnel URL: $tunnelUrl"
                break
            }
        }
    }
    if ($null -eq $tunnelUrl) {
        throw "Failed to obtain Cloudflare Tunnel URL. Check Clash/TUN routing or cloudflared logs at $logFile."
    }

    # Custody is updated before any Worker/DNS readiness check. If trycloudflare
    # takes time to publish DNS and setup exits non-zero, later noop/-Reregister
    # must still recover this live hostname rather than the previous dead one.
    Update-CurrentQuickTunnelCustody -TunnelUrl $tunnelUrl
    return $tunnelUrl
}

function Bind-DevSpaceOriginProcess {
    $found = Find-DevSpaceServeProcess
    if ($found) {
        $script:devspaceProcess = Get-Process -Id $found.ProcessId -ErrorAction SilentlyContinue
    }
    return ($null -ne $script:devspaceProcess)
}

function Complete-DevSpaceRuntimeRecord {
    param(
        [Parameter(Mandatory = $true)][string]$DevSpaceSourceDir,
        [Parameter(Mandatory = $true)][string]$DevSpaceCli,
        [Parameter(Mandatory = $true)][string]$TunnelUrl,
        [Parameter(Mandatory = $true)][string]$TunnelHost,
        [string[]]$LocalTools = @(),
        [string[]]$PublicTools = @()
    )

    Bind-DevSpaceOriginProcess | Out-Null
    if ($null -eq $script:devspaceProcess) {
        throw "Cannot write runtime state: DevSpace origin process was not found."
    }
    if ($null -eq $script:cloudflaredProcess) {
        [void](Test-DevSpaceQuickTunnelAlive)
    }
    $gitIdentity = Get-DevSpaceGitIdentity -RepositoryRoot $DevSpaceSourceDir -CliPath $DevSpaceCli -SetupScriptPath $PSCommandPath
    Write-SetupLog "Runtime source: commit=$($gitIdentity.commit) branch=$($gitIdentity.branch) dirty=$($gitIdentity.dirty) dirtyFingerprint=$($gitIdentity.dirtyFingerprintSha256)"
    Save-RuntimeState `
        -DevSpacePid $script:devspaceProcess.Id `
        -CloudflaredPid $(if ($script:cloudflaredProcess) { $script:cloudflaredProcess.Id } else { 0 }) `
        -TunnelUrl $TunnelUrl `
        -TunnelHost $TunnelHost `
        -GitIdentity $gitIdentity `
        -LocalTools @($LocalTools) `
        -PublicTools @($PublicTools)
}

function Invoke-DevSpaceDiscoveryValidation {
    param(
        [Parameter(Mandatory = $true)][string]$TunnelUrl,
        [int]$RetryTimeoutSec = 90
    )

    Write-Host "`nTesting Discovery Endpoints:"
    Write-Host "----------------------------"
    $endpoints = @(
        "/.well-known/oauth-protected-resource/mcp"
        "/.well-known/oauth-authorization-server"
        "/.well-known/openid-configuration"
    )
    $pending = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
    foreach ($ep in $endpoints) { [void]$pending.Add($ep) }
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $attempt = 0
    $delaySeconds = 2

    while ($pending.Count -gt 0 -and $watch.Elapsed.TotalSeconds -lt $RetryTimeoutSec) {
        $attempt++
        foreach ($ep in @($pending)) {
            $url = "$PublicProxyBase$ep"
            Write-Host "Testing: $url (attempt $attempt)"
            $response = Get-HttpBody -url $url -timeoutSec 12 -PreferIpv4
            if (Test-DevSpaceDiscoveryDocument -Path $ep -Body $response -PublicBaseUrl $PublicProxyBase) {
                Write-Host "Check OK."
                [void]$pending.Remove($ep)
            } else {
                $preview = if ([string]::IsNullOrWhiteSpace($response)) { "(empty)" } elseif ($response.Length -gt 180) { $response.Substring(0, 180) + "..." } else { $response }
                Write-Warning "Discovery document is not valid DevSpace OAuth metadata at $url. Response: $preview"
            }
        }
        if ($pending.Count -eq 0) { break }
        $remaining = $RetryTimeoutSec - $watch.Elapsed.TotalSeconds
        if ($remaining -le 0) { break }
        $sleepSeconds = [Math]::Min($delaySeconds, [Math]::Max(1, [Math]::Floor($remaining)))
        Start-Sleep -Seconds $sleepSeconds
        $delaySeconds = [Math]::Min(10, [Math]::Ceiling($delaySeconds * 1.6))
    }

    Write-Host "----------------------------`n"
    if ($pending.Count -gt 0) {
        throw "Discovery endpoint checks failed after a bounded retry window. Failed: $(@($pending) -join ', '). Origin and tunnel were left running. Active tunnel: $TunnelUrl"
    }
}

function Invoke-DevSpaceInventoryAndDiscovery {
    param(
        [Parameter(Mandatory = $true)][string]$TunnelHost,
        [Parameter(Mandatory = $true)][string]$AuthFile,
        [Parameter(Mandatory = $true)][string]$TunnelUrl,
        # Use only when discovery was already verified live earlier in this setup run.
        [switch]$SkipDiscovery
    )

    if (-not $SkipDiscovery) {
        Invoke-DevSpaceDiscoveryValidation -TunnelUrl $TunnelUrl
    }

    Write-Host "Verifying authenticated MCP tool inventories..."
    $authConfig = Get-Content -LiteralPath $AuthFile -Raw | ConvertFrom-Json
    $ownerToken = [string]$authConfig.ownerToken
    if ([string]::IsNullOrWhiteSpace($ownerToken)) {
        throw "DevSpace auth.json does not contain ownerToken."
    }
    $probeAccessToken = New-DevSpaceProbeAccessToken `
        -LocalBaseUrl "http://${LocalHost}:${LocalPort}" `
        -ResourceUrl "$PublicProxyBase/mcp" `
        -OwnerToken $ownerToken
    $localTools = Invoke-AuthenticatedToolsList `
        -BaseUrl "http://${LocalHost}:${LocalPort}" `
        -AccessToken $probeAccessToken
    $localTools = Assert-ExpectedToolInventory -EndpointLabel "Local" -ExpectedTools $ExpectedTools -ActualTools $localTools
    $publicTools = Invoke-AuthenticatedToolsList `
        -BaseUrl $PublicProxyBase `
        -AccessToken $probeAccessToken `
        -RetryTimeoutSec 180
    $publicTools = Assert-ExpectedToolInventory -EndpointLabel "Public Worker" -ExpectedTools $ExpectedTools -ActualTools $publicTools
    return [pscustomobject]@{ LocalTools = $localTools; PublicTools = $publicTools }
}

function Initialize-DevSpaceSessionEnvironment {
    $detectedProxy = $null
    try {
        $systemProxy = [System.Net.WebRequest]::GetSystemWebProxy()
        $testUri = [System.Uri]$PublicProxyBase
        $proxyUri = $systemProxy.GetProxy($testUri)
        if ($proxyUri -and $proxyUri.Host -ne $testUri.Host) {
            $detectedProxy = $proxyUri.AbsoluteUri
            Write-Host "Detected system proxy: $detectedProxy"
        }
    } catch {
        Write-Warning "Failed to query system proxy: $_"
    }
    if ($null -eq $detectedProxy) {
        $commonPorts = @(7890, 7897, 10809, 1080, 10808)
        foreach ($port in $commonPorts) {
            if (Test-PortOpen "127.0.0.1" $port) {
                $detectedProxy = "http://127.0.0.1:$port"
                Write-Host "Detected open local proxy port: $port"
                break
            }
        }
    }
    if ($null -ne $detectedProxy) {
        $env:http_proxy = $detectedProxy
        $env:https_proxy = $detectedProxy
        $env:HTTP_PROXY = $detectedProxy
        $env:HTTPS_PROXY = $detectedProxy
        Write-SetupLog "Configured session proxy for cloudflared: $detectedProxy"
    }

    $currentPaths = $env:Path -split ";"
    $machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
    $registryPaths = ($machinePath + ";" + $userPath) -split ";"
    $mergedPaths = @()
    foreach ($p in ($currentPaths + $registryPaths)) {
        $trimmed = if ($null -ne $p) { $p.Trim() } else { "" }
        if ($trimmed -and $mergedPaths -notcontains $trimmed) {
            $mergedPaths += $trimmed
        }
    }
    $env:Path = $mergedPaths -join ";"
    return $detectedProxy
}

function Finish-DevSpaceBackgroundOrMonitor {
    param(
        [Parameter(Mandatory = $true)][string]$TunnelUrl,
        [Parameter(Mandatory = $true)][string]$DevSpaceCli
    )

    $script:leaveRunning = $true
    if (-not $Monitor) {
        Write-Host ""
        Write-Host "DevSpace is running in the background (this window can close)." -ForegroundColor Green
        Write-Host "  Public:  $PublicProxyBase"
        Write-Host "  Tunnel:  $TunnelUrl"
        Write-Host "  PIDs:    devspace=$(if ($script:devspaceProcess) { $script:devspaceProcess.Id } else { 'n/a' }) cloudflared=$(if ($script:cloudflaredProcess) { $script:cloudflaredProcess.Id } else { 'n/a' })"
        Write-Host "  State:   $script:runtimePidFile"
        Write-Host "  Monitor: powershell -ExecutionPolicy Bypass -File E:\Code\devspace\setup_devspace.ps1 -Monitor"
        Write-SetupLog "Background mode: leaving processes running; exiting launcher."
        return
    }

    Write-Host "Entering steady-state monitor (-Monitor). Ctrl+C stops services."
    try {
        $null = [Console]::Add_CancelKeyPress({
            param($sender, $eventArgs)
            $eventArgs.Cancel = $true
            $script:intentionalStop = $true
            $script:leaveRunning = $false
            Write-Host "`nCtrl+C received — shutting down cleanly..."
        })
    } catch {}

    while ($true) {
        if ($script:intentionalStop) {
            Write-SetupLog "Intentional stop requested."
            $script:leaveRunning = $false
            break
        }

        Start-Sleep -Seconds 5

        $dsAlive = Test-ManagedProcessAlive $script:devspaceProcess
        $cfAlive = Test-ManagedProcessAlive $script:cloudflaredProcess
        $localOk = Test-LocalDevSpaceHealthy

        if (-not $dsAlive -or -not $localOk) {
            $found = Find-DevSpaceServeProcess
            if ($found) {
                $script:devspaceProcess = Get-Process -Id $found.ProcessId -ErrorAction SilentlyContinue
                $dsAlive = $null -ne $script:devspaceProcess
                $localOk = Test-LocalDevSpaceHealthy
            }
        }

        if (-not $cfAlive) {
            Write-SetupLog "cloudflared not alive — background services may need re-run of setup." "WARN"
        }
        if (-not $localOk) {
            Write-SetupLog "Local healthz down. Check logs: $script:devspaceStderrLog" "WARN"
        } else {
            Write-Host ("[{0}] healthz ok (devspace PID={1})" -f (Get-Date -Format "HH:mm:ss"), $script:devspaceProcess.Id)
        }
    }
}

# --- main ---
if ($LibraryOnly) {
    return
}

$exitCode = 0
$devspaceSourceDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$devspaceCli = Join-Path $devspaceSourceDir "dist\cli.js"
$prepareLaunchScript = Join-Path $devspaceSourceDir "scripts\prepare-devspace-launch.ps1"
$script:previousDistDirectory = Join-Path $devspaceSourceDir "dist-previous"

function Invoke-DevSpaceWorkerRepair {
    param(
        [Parameter(Mandatory = $true)][string]$TunnelUrl,
        [Parameter(Mandatory = $true)][string]$AuthToken,
        [string]$DetectedProxy,
        [Parameter(Mandatory = $true)][string]$TunnelHost
    )

    # /set-tunnel 200 only stores the Worker pointer. A new trycloudflare name can
    # still return 530/1016. Wait until GET /healthz is DevSpace JSON and POST /mcp
    # reaches origin (401 missing token is success). Do not treat healthz-only as ready.
    Register-TunnelWithProxy -tunnelUrl $TunnelUrl -authToken $AuthToken -detectedProxy $DetectedProxy
    if (-not (Test-ProxyUsesTunnel -expectedTunnelHost $TunnelHost -timeoutSec 180)) {
        throw "Public MCP proxy health check failed for $PublicProxyBase after /set-tunnel and a 180-second readiness window. Origin and quick tunnel were left running. Expected upstream: $TunnelHost"
    }
}

try {
Write-SetupLog "==== DevSpace setup starting (log: $script:setupLogFile) ===="
if (Test-DevSpaceGitWorktreePath $devspaceSourceDir) {
    throw "Refusing to run production setup from Git worktree '$devspaceSourceDir'. Use E:\Code\devspace\setup_devspace.ps1"
}

Enter-DevSpaceSetupLock -LockPath $script:setupLockFile | Out-Null
$script:setupLockHeld = $true

Set-DevSpaceStartupShortcut
$configDir = Join-Path $env:USERPROFILE ".devspace"
if (!(Test-Path $configDir)) {
    New-Item -ItemType Directory -Path $configDir -Force | Out-Null
}
$pinPath = Get-DevSpacePreferredSourcePinPath
if ($PinPreferredSource) {
    Save-DevSpacePreferredRuntimeSource -PinPath $pinPath -Repository $devspaceSourceDir
    Write-SetupLog "Pinned preferred runtime source to $devspaceSourceDir"
}
$pin = Assert-DevSpacePreferredRuntimeSource `
    -ApprovedCheckout $devspaceSourceDir `
    -PinPath $pinPath `
    -OverridePreferredSource:$OverridePreferredSource

$detectedProxy = Initialize-DevSpaceSessionEnvironment
$authToken = $env:DEVSPACE_PROXY_AUTH_TOKEN
if ($null -eq $authToken -and (Test-Path (Join-Path $configDir "proxy_token.txt"))) {
    $authToken = (Get-Content (Join-Path $configDir "proxy_token.txt") -Raw).Trim()
}
if ([string]::IsNullOrWhiteSpace($authToken)) {
    throw "Proxy authentication token not found. Set DEVSPACE_PROXY_AUTH_TOKEN or place it in '$configDir\proxy_token.txt'."
}

$authFile = Join-Path $configDir "auth.json"
if (!(Test-Path $authFile)) {
    Write-Host "Generating auth.json..."
    $bytes = New-Object Byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $token = [System.Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_').Replace('=', '')
    $auth = @{ ownerToken = $token }
    [System.IO.File]::WriteAllText($authFile, (($auth | ConvertTo-Json) + "`n"))
} else {
    Write-Host "Using existing auth.json configuration."
}

$localOk = Test-LocalDevSpaceHealthy
$workerOk = Test-WorkerDevSpaceHealthy
$tunnelAlive = Test-DevSpaceQuickTunnelAlive
$decision = Get-DevSpaceHealDecision `
    -LocalHealthy $localOk `
    -WorkerHealthy $workerOk `
    -QuickTunnelAlive $tunnelAlive `
    -ForceReregister:$Reregister
Write-SetupLog "Heal decision: action=$($decision.Action) preserveNode=$($decision.PreserveNode) preserveDist=$($decision.PreserveActiveDist) preserveTunnelHost=$($decision.PreserveTunnelHostname)"

$preNodePid = $null
$preDistFingerprint = Get-DevSpaceDistFingerprint -CliPath $devspaceCli
if ($localOk) {
    Bind-DevSpaceOriginProcess | Out-Null
    if ($script:devspaceProcess) {
        $preNodePid = $script:devspaceProcess.Id
        Write-SetupLog "Sacred origin bound PID=$preNodePid distFingerprint=$preDistFingerprint"
    }
}

$tunnelUrl = $null
$tunnelHost = $null
$localTools = @()
$publicTools = @()

switch ($decision.Action) {
    "noop" {
        $tunnelUrl = Get-CurrentQuickTunnelUrl
        if ([string]::IsNullOrWhiteSpace($tunnelUrl)) {
            throw "Local origin and Worker are healthy but the current quick-tunnel URL could not be recovered from cloudflared, supervisor, or runtime logs."
        }
        $tunnelHost = ([System.Uri]$tunnelUrl).Host
        Write-SetupLog "Public path is healthy; skipping recycle, rebuild, and tunnel remint."
        # Validate cache provenance before mutating runtime custody. Otherwise a
        # stale cache could inherit the newly recovered tunnel host/PID and look current.
        $state = Read-DevSpaceRuntimeState
        $cachedInventory = Get-DevSpaceValidatedCachedToolInventory `
            -State $state `
            -ExpectedTools $ExpectedTools `
            -ExpectedDevSpacePid $(if ($preNodePid) { [int]$preNodePid } else { 0 }) `
            -ExpectedCliSha256 $preDistFingerprint `
            -ExpectedTunnelHost $tunnelHost `
            -ExpectedPublicBaseUrl $PublicProxyBase
        if ($null -ne $cachedInventory) {
            $localTools = @($cachedInventory.Local)
            $publicTools = @($cachedInventory.Public)
            Write-SetupLog "Validated cached tool inventory against current PID, CLI fingerprint, tunnel host, public base, and exact expected tools."
        } else {
            Write-SetupLog "Cached tool inventory is missing, stale, or mismatched; live inventory verification is required." "WARN"
        }
        Update-CurrentQuickTunnelCustody -TunnelUrl $tunnelUrl
    }
    "reregister" {
        $tunnelUrl = Get-CurrentQuickTunnelUrl
        if ([string]::IsNullOrWhiteSpace($tunnelUrl)) {
            throw "Quick tunnel is alive but its URL could not be recovered for /set-tunnel."
        }
        $tunnelHost = ([System.Uri]$tunnelUrl).Host
        Invoke-DevSpaceWorkerRepair -TunnelUrl $tunnelUrl -AuthToken $authToken -DetectedProxy $detectedProxy -TunnelHost $tunnelHost
    }
    "restart-tunnel" {
        if (-not $localOk) {
            throw "Internal error: restart-tunnel requires a healthy origin."
        }
        Stop-DevSpaceCloudflaredOnly
        $tunnelUrl = Start-CloudflaredQuickTunnel
        $tunnelHost = ([System.Uri]$tunnelUrl).Host
        Invoke-DevSpaceWorkerRepair -TunnelUrl $tunnelUrl -AuthToken $authToken -DetectedProxy $detectedProxy -TunnelHost $tunnelHost
    }
    "staged-recycle" {
        Assert-DevSpaceSourceCleanForRecycle -Repository $devspaceSourceDir -AllowDirty:$AllowDirty -Pin $pin
        Write-SetupLog "Local origin is down; stopping leftover processes before staged build."
        Stop-DevSpaceRelatedProcesses
        Start-Sleep -Seconds 2
        Write-Host "Preparing local DevSpace build (staged snapshot, then build)..."
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $prepareLaunchScript -RepositoryRoot $devspaceSourceDir -PreviousDistDirectory $script:previousDistDirectory
        if ($LASTEXITCODE -ne 0) {
            throw "DevSpace launch preparation failed. The server was not started."
        }
        if (!(Test-Path $devspaceCli)) {
            throw "DevSpace CLI not found at '$devspaceCli'."
        }
        Start-Process -FilePath "node" -ArgumentList @($devspaceCli, "config", "set", "publicBaseUrl", $PublicProxyBase) -NoNewWindow -Wait | Out-Null
        $tunnelUrl = Start-CloudflaredQuickTunnel
        $tunnelHost = ([System.Uri]$tunnelUrl).Host
        Register-TunnelWithProxy -tunnelUrl $tunnelUrl -authToken $authToken -detectedProxy $detectedProxy
        try {
            $script:devspaceProcess = Start-DevSpaceServer -devspaceCli $devspaceCli -tunnelHost $tunnelHost
        } catch {
            if (Restore-DevSpaceDistSnapshot -DistDirectory (Join-Path $devspaceSourceDir "dist") -SnapshotDirectory $script:previousDistDirectory) {
                Write-SetupLog "Restored previous dist snapshot after origin start failure." "WARN"
            }
            throw
        }
        Register-TunnelWithProxy -tunnelUrl $tunnelUrl -authToken $authToken -detectedProxy $detectedProxy
        Write-Host "Waiting for Cloudflare edge registration (from cloudflared log)..." -NoNewline
        $edgeReady = $false
        $logFile = $script:cloudflaredLogFile
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Seconds 1
            Write-Host "." -NoNewline
            if (-not (Test-ManagedProcessAlive $script:cloudflaredProcess)) {
                throw "Cloudflare Tunnel stopped during startup. ExitCode=$(Get-SafeExitCode $script:cloudflaredProcess). See $logFile"
            }
            if (-not (Test-ManagedProcessAlive $script:devspaceProcess)) {
                throw "DevSpace stopped during startup. PID=$($script:devspaceProcess.Id); ExitCode=$(Get-SafeExitCode $script:devspaceProcess)."
            }
            if (Test-CloudflaredEdgeRegistered -logPath $logFile) {
                $edgeReady = $true
                Write-Host "`nCloudflare edge: Registered tunnel connection."
                break
            }
        }
        if (-not $edgeReady) {
            Write-Warning "`nDid not observe 'Registered tunnel connection' in $logFile yet; continuing with proxy checks."
        }
        Invoke-DevSpaceWorkerRepair -TunnelUrl $tunnelUrl -AuthToken $authToken -DetectedProxy $detectedProxy -TunnelHost $tunnelHost
    }
    default {
        throw "Unknown heal decision '$($decision.Action)'."
    }
}

if ($decision.PreserveNode -and $preNodePid) {
    Bind-DevSpaceOriginProcess | Out-Null
    if ($null -eq $script:devspaceProcess -or [int]$script:devspaceProcess.Id -ne [int]$preNodePid) {
        throw "Heal path was required to preserve Node PID $preNodePid but the origin PID changed."
    }
    $postDistFingerprint = Get-DevSpaceDistFingerprint -CliPath $devspaceCli
    if ($preDistFingerprint -and $postDistFingerprint -and $preDistFingerprint -ne $postDistFingerprint) {
        throw "Heal path was required to preserve the active dist fingerprint."
    }
}

$discoveryVerifiedThisRun = $false
if ($decision.Action -eq "noop") {
    # Worker health proves routing to the origin, but OAuth discovery is a separate
    # contract used by connector clients and must be verified independently.
    Invoke-DevSpaceDiscoveryValidation -TunnelUrl $tunnelUrl
    $discoveryVerifiedThisRun = $true
}

if ($decision.Action -ne "noop" -or @($localTools).Count -eq 0 -or @($publicTools).Count -eq 0) {
    $inventory = Invoke-DevSpaceInventoryAndDiscovery `
        -TunnelHost $tunnelHost `
        -AuthFile $authFile `
        -TunnelUrl $tunnelUrl `
        -SkipDiscovery:$discoveryVerifiedThisRun
    $localTools = @($inventory.LocalTools)
    $publicTools = @($inventory.PublicTools)
    Write-SetupLog "Setup finished. Exact connector tools: $($ExpectedTools -join ', ')."
    Write-Host ""
    Write-Host "Live MCP endpoint: $($localTools.Count) tools (localhost and public Worker verified)" -ForegroundColor Green
} else {
    Write-SetupLog "Setup finished using a validated inventory cache bound to the current live origin and tunnel. Exact connector tools: $($ExpectedTools -join ', ')."
    Write-Host ""
    Write-Host "Live MCP endpoint: $($localTools.Count) tools (cached inventory provenance validated; public discovery verified live)" -ForegroundColor Green
}

Complete-DevSpaceRuntimeRecord `
    -DevSpaceSourceDir $devspaceSourceDir `
    -DevSpaceCli $devspaceCli `
    -TunnelUrl $tunnelUrl `
    -TunnelHost $tunnelHost `
    -LocalTools $localTools `
    -PublicTools $publicTools
Write-SetupLog "Public MCP base: $PublicProxyBase"
Write-SetupLog "Active tunnel host: $tunnelHost"
Finish-DevSpaceBackgroundOrMonitor -TunnelUrl $tunnelUrl -DevSpaceCli $devspaceCli
} catch {
    if ($script:intentionalStop) {
        Write-SetupLog "Stopped by user."
        $exitCode = 0
        $script:leaveRunning = $false
    } else {
        $disposition = Get-DevSpaceFailureDisposition -LocalHealthy (Test-LocalDevSpaceHealthy)
        $exitCode = $disposition.ExitCode
        $script:leaveRunning = $disposition.LeaveRunning
        Write-Host ""
        Write-Host "========== DEVSPACE SETUP/RUNTIME ERROR ==========" -ForegroundColor Red
        Write-Host $_.Exception.Message -ForegroundColor Red
        if ($_.ScriptStackTrace) {
            Write-Host $_.ScriptStackTrace
        }
        Write-Host "==================================================" -ForegroundColor Red
        Write-SetupLog $_.Exception.Message "ERROR"
        if ($disposition.PreserveOrigin) {
            Write-SetupLog "Preserving healthy origin after setup failure (sacred origin)." "WARN"
        }
    }
} finally {
    if ($script:leaveRunning) {
        Write-Host "`nLeaving DevSpace + cloudflared running in background."
    } else {
        Write-Host "`nStopping DevSpace and Cloudflare Tunnel..."
        Stop-TrackedProcesses
        try { Stop-DevSpaceRuntime } catch {}
    }
    if ($script:setupLockHeld) {
        Exit-DevSpaceSetupLock -LockPath $script:setupLockFile
        $script:setupLockHeld = $false
    }
}

if ($exitCode -ne 0) {
    exit $exitCode
}
