# Usage from E:\Code\devspace (run in interactive Windows PowerShell, not DevSpace bash):
#   powershell -ExecutionPolicy Bypass -File .\setup_devspace.ps1           # compatibility launcher
#   powershell -ExecutionPolicy Bypass -File .\setup_devspace.ps1 -Monitor  # setup + keep console monitor
#   powershell -ExecutionPolicy Bypass -File .\setup_devspace.ps1 -Stop     # stop background services
# Canonical version-controlled implementation: devspace-src\scripts\setup-devspace.ps1
#
# The live MCP runtime must expose the exact nine-tool DevSpace contract below.
# ChatGPT custom-app action schemas are separate snapshots: refresh or republish
# the app after changing tools, and start a new conversation to adopt the schema.
param(
    [switch]$Monitor,
    [switch]$Stop,
    [switch]$LibraryOnly
)

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
$script:devspaceCliPath = $null
$script:setupLogFile = Join-Path $env:TEMP "devspace_setup.log"
$script:runtimePidFile = Join-Path $env:USERPROFILE ".devspace\runtime.json"
$script:probeClientFile = Join-Path $env:USERPROFILE ".devspace\setup-probe-client.json"

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
    "close_workspace",
    "edit",
    "open_workspace",
    "publish_git_changes",
    "read",
    "read_files",
    "review_start",
    "review_status",
    "review_submit",
    "safe_rename_file",
    "web_connector_probe",
    "web_connector_start",
    "web_connector_status",
    "web_launch",
    "write"
)
. (Join-Path $PSScriptRoot "setup-devspace-support.ps1")

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

        $WshShell = New-Object -ComObject WScript.Shell
        $Shortcut = $WshShell.CreateShortcut($shortcutPath)
        $Shortcut.TargetPath = "powershell.exe"
        $Shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
        $Shortcut.WorkingDirectory = $PSScriptRoot
        $Shortcut.WindowStyle = 1
        $Shortcut.Save()
        Write-Host "Visible startup shortcut configured at: $shortcutPath"
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
    $health = Get-HttpBody -url "http://${LocalHost}:${LocalPort}/healthz" -timeoutSec 2
    return ($health -match 'devspace')
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

function Invoke-AuthenticatedToolsList {
    param(
        [Parameter(Mandatory = $true)][string]$BaseUrl,
        [Parameter(Mandatory = $true)][string]$AccessToken
    )

    $headers = @{
        Authorization = "Bearer $AccessToken"
        Accept        = "application/json, text/event-stream"
    }
    $initialize = Invoke-NoProxyHttpRequest `
        -Url "$BaseUrl/mcp" `
        -Method "POST" `
        -Headers $headers `
        -Body (@{
            jsonrpc = "2.0"
            id      = 1
            method  = "initialize"
            params  = @{
                protocolVersion = "2024-11-05"
                capabilities    = @{}
                clientInfo      = @{ name = "devspace-setup"; version = "1.0.0" }
            }
        } | ConvertTo-Json -Depth 8 -Compress)
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
        $initialized = Invoke-NoProxyHttpRequest `
            -Url "$BaseUrl/mcp" `
            -Method "POST" `
            -Headers $sessionHeaders `
            -Body (@{
                jsonrpc = "2.0"
                method  = "notifications/initialized"
            } | ConvertTo-Json -Compress)
        if ($initialized.StatusCode -lt 200 -or $initialized.StatusCode -ge 300) {
            throw "MCP initialized notification failed at '$BaseUrl' with HTTP $($initialized.StatusCode): $($initialized.Body)"
        }

        $toolsList = Invoke-NoProxyHttpRequest `
            -Url "$BaseUrl/mcp" `
            -Method "POST" `
            -Headers $sessionHeaders `
            -Body (@{
                jsonrpc = "2.0"
                id      = 2
                method  = "tools/list"
            } | ConvertTo-Json -Compress)
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
        [Parameter(Mandatory = $true)][string[]]$LocalTools,
        [Parameter(Mandatory = $true)][string[]]$PublicTools
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
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $cmd = if ($_.CommandLine) { $_.CommandLine } else { "" }
        $_.Name -eq "cloudflared.exe" -or $cmd -match 'devspace-src.*cli\.js.*serve'
    } | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path $script:runtimePidFile) {
        Remove-Item $script:runtimePidFile -Force -ErrorAction SilentlyContinue
    }
    Write-SetupLog "Stop complete."
}

function Find-DevSpaceServeProcess {
    param([string]$ExpectedCliPath = $null)

    # Match main-repo, worktree, and absolute installs:
    #   ...\devspace-src\dist\cli.js serve
    #   ...\devspace-src\.worktrees\<id>\dist\cli.js serve
    # The old pattern required devspace-src\dist immediately and missed worktrees.
    $candidates = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $cmd = if ($_.CommandLine) { $_.CommandLine } else { "" }
        if ($cmd -notmatch 'serve') { return $false }
        if ($cmd -match 'dist[\\/]+cli\.js') { return $true }
        if ($cmd -match 'cli\.js["\s]+serve') { return $true }
        if ($ExpectedCliPath) {
            $normExpected = ($ExpectedCliPath -replace '/', '\').ToLowerInvariant()
            $normCmd = ($cmd -replace '/', '\').ToLowerInvariant()
            if ($normCmd.Contains($normExpected)) { return $true }
        }
        return $false
    })

    if ($ExpectedCliPath -and $candidates.Count -gt 0) {
        $normExpected = ($ExpectedCliPath -replace '/', '\').ToLowerInvariant()
        $exact = $candidates | Where-Object {
            $normCmd = ($_.CommandLine -replace '/', '\').ToLowerInvariant()
            $normCmd.Contains($normExpected)
        } | Select-Object -First 1
        if ($exact) { return $exact }
    }
    return $candidates | Select-Object -First 1
}

function Get-ListenerProcessId([int]$port) {
    try {
        $owner = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique |
            Select-Object -First 1
        if ($owner) { return [int]$owner }
    } catch {}
    return $null
}

function Resolve-DevSpaceServeProcess {
    param(
        [string]$ExpectedCliPath = $null,
        [System.Diagnostics.Process]$Preferred = $null
    )
    if ($Preferred -and (Test-ManagedProcessAlive $Preferred)) {
        return $Preferred
    }

    $found = Find-DevSpaceServeProcess -ExpectedCliPath $ExpectedCliPath
    if ($found) {
        $byCmd = Get-Process -Id $found.ProcessId -ErrorAction SilentlyContinue
        if ($byCmd) { return $byCmd }
    }

    # Port-based rebind: WMI may have started a healthy serve that cmdline discovery missed.
    $ownerId = Get-ListenerProcessId -port $LocalPort
    if ($ownerId) {
        $byPort = Get-Process -Id $ownerId -ErrorAction SilentlyContinue
        if ($byPort) { return $byPort }
    }
    return $null
}

function Stop-DevSpaceRelatedProcesses {
    Write-Host "Stopping existing cloudflared, ngrok, and any process holding DevSpace ports..."

    $targets = Get-CimInstance Win32_Process | Where-Object {
        $cmd = if ($null -ne $_.CommandLine) { $_.CommandLine } else { "" }
        $name = $_.Name
        $name -eq "cloudflared.exe" -or
        $name -eq "ngrok.exe" -or
        $cmd -like "*@waishnav/devspace*" -or
        $cmd -match 'cli\.js["\s]+serve' -or
        $cmd -match 'dist[/\\]cli\.js' -or
        $cmd -like "*chatgpt-push*" -or
        ($cmd -like "*devspace*" -and $cmd -like "*serve*")
    }

    foreach ($proc in $targets) {
        $cmdPreview = if ($proc.CommandLine) { $proc.CommandLine.Substring(0, [Math]::Min(100, $proc.CommandLine.Length)) } else { $proc.Name }
        Write-Host "  Stopping PID $($proc.ProcessId): $cmdPreview"
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    }

    # Always free listeners on MCP / device-proof ports (catches unknown binaries).
    foreach ($port in @($LocalPort, $DeviceProofPort)) {
        try {
            $listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
            foreach ($listener in $listeners) {
                $owner = $listener.OwningProcess
                if ($owner -and $owner -ne $PID) {
                    $ownerCmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$owner" -ErrorAction SilentlyContinue).CommandLine
                    Write-Host "  Freeing port $port (PID $owner) $ownerCmd"
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

function Test-ProxyUsesTunnel([string]$expectedTunnelHost, [int]$attempts = 8) {
    $probeUrl = "$PublicProxyBase/healthz"
    $tunnelHost = $expectedTunnelHost

    for ($i = 1; $i -le $attempts; $i++) {
        $body = Get-HttpBody -url $probeUrl -timeoutSec 15 -PreferIpv4
        if (($body -match '"ok"\s*:\s*true' -or $body -match '"name"\s*:\s*"devspace"') -and $body -match 'devspace') {
            Write-Host "Proxy healthz OK (attempt $i): $body"
            return $true
        }

        # Stale upstream: Cloudflare HTML Origin DNS error names the old trycloudflare host.
        $titleMatch = [regex]::Match($body, "(?i)<title>(.*?)</title>")
        $staleMatch = [regex]::Match($body, "([a-z0-9-]+\.trycloudflare\.com)")
        if ($titleMatch.Success -or $staleMatch.Success) {
            $title = if ($titleMatch.Success) { $titleMatch.Groups[1].Value } else { "(no title)" }
            $seen = if ($staleMatch.Success) { $staleMatch.Groups[1].Value } else { "(unknown)" }
            if ($seen -ne $tunnelHost -and $seen -ne "(unknown)") {
                Write-Warning "Proxy still routing to stale tunnel host '$seen' (expected '$tunnelHost') [attempt $i/$attempts]. Title: $title"
            } else {
                Write-Warning "Proxy upstream not serving yet (seen='$seen') [attempt $i/$attempts]. Title: $title"
            }
        } elseif ($body -match 'Invalid Host:\s*([a-z0-9.-]+)') {
            $invalidHost = $Matches[1]
            Write-Warning "DevSpace rejected Host '$invalidHost' via proxy [attempt $i/$attempts]. Allowlist may be stale."
        } else {
            $preview = if ($body.Length -gt 160) { $body.Substring(0, 160) + "..." } else { $body }
            Write-Warning "Proxy healthz not ready [attempt $i/$attempts]: $preview"
        }

        Start-Sleep -Seconds 2
    }

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
        allowedHosts  = @($proxyHost, $tunnelHost, "localhost", "127.0.0.1")
    }
    $configJson = $config | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText((Join-Path $configDir "config.json"), $configJson + "`n")
    Write-Host "Updated $(Join-Path $configDir 'config.json')"

    $env:DEVSPACE_PUBLIC_BASE_URL = $PublicProxyBase
    # No space after commas; parser trims, but keep the value clean.
    $env:DEVSPACE_ALLOWED_HOSTS = "$proxyHost,$tunnelHost,localhost,127.0.0.1"
    $env:DEVSPACE_ALLOWED_ROOTS = $AllowedRootsEnv
    $env:DEVSPACE_TRUST_PROXY = "true"
    $env:DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS = "chatgpt.com,claude.ai,oauth-redirect-sandbox.googleusercontent.com,oauth-redirect-test.googleusercontent.com,oauth-redirect.googleusercontent.com,perplexity.ai,*.perplexity.ai,www.perplexity.com,enterprise.perplexity.com,n.perplexity.com,staging.perplexity.com,chatshare.xyz,*.chatshare.xyz,localhost,127.0.0.1"
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

    $script:devspaceCliPath = $devspaceCli
    $proc = $null
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 400
        $proc = Resolve-DevSpaceServeProcess -ExpectedCliPath $devspaceCli
        if ($proc) { break }
        # Healthy listener without a matched cmdline still counts (worktree / permission edge cases).
        if (Test-LocalDevSpaceHealthy) {
            $proc = Resolve-DevSpaceServeProcess -ExpectedCliPath $devspaceCli
            if ($proc) { break }
        }
    }
    if ($null -eq $proc) {
        # Never dual-launch when something already answers /healthz on LocalPort.
        if (Test-LocalDevSpaceHealthy) {
            $ownerId = Get-ListenerProcessId -port $LocalPort
            throw "DevSpace is healthy on port $LocalPort (PID=$ownerId) but the serve process handle could not be resolved. Avoiding a second Start-Process launch."
        }
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

        $health = Get-HttpBody -url "http://${LocalHost}:${LocalPort}/healthz" -timeoutSec 2
        if ($health -match 'devspace') {
            # Confirm tunnel host is allowed (this is what cloudflared will send).
            $withTunnelHost = Get-HttpBody -url "http://${LocalHost}:${LocalPort}/healthz" -timeoutSec 2 -headers @{ Host = $tunnelHost }
            if ($withTunnelHost -match 'Invalid Host') {
                throw "Local DevSpace is listening but rejects Host '$tunnelHost'. Check DEVSPACE_ALLOWED_HOSTS / config.json."
            }
            if ($withTunnelHost -match 'devspace' -or $withTunnelHost -eq "" -or $withTunnelHost -match '"ok"') {
                $ready = $true
                break
            }
            # healthz may still return ok JSON under allowed host
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

# --- main ---
if ($LibraryOnly) {
    return
}

$exitCode = 0

if ($Stop) {
    Stop-DevSpaceRuntime
    exit 0
}

try {
Write-SetupLog "==== DevSpace setup starting (log: $script:setupLogFile) ===="
Set-DevSpaceStartupShortcut
Stop-DevSpaceRelatedProcesses

# Scan for local or system proxy before starting cloudflared
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
    # cloudflared reads these; Worker registration intentionally uses --noproxy.
    $env:http_proxy = $detectedProxy
    $env:https_proxy = $detectedProxy
    $env:HTTP_PROXY = $detectedProxy
    $env:HTTPS_PROXY = $detectedProxy
    # Do not force ALL curl through Clash — set-tunnel / health checks use --noproxy.
    Write-SetupLog "Configured session proxy for cloudflared: $detectedProxy"
}

$configDir = Join-Path $env:USERPROFILE ".devspace"
if (!(Test-Path $configDir)) {
    New-Item -ItemType Directory -Path $configDir -Force | Out-Null
}

# Ensure PATH includes machine/user entries for cloudflared.
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

$authToken = $env:DEVSPACE_PROXY_AUTH_TOKEN
if ($null -eq $authToken -and (Test-Path (Join-Path $configDir "proxy_token.txt"))) {
    $authToken = (Get-Content (Join-Path $configDir "proxy_token.txt") -Raw).Trim()
}
if ([string]::IsNullOrWhiteSpace($authToken)) {
    throw "Proxy authentication token not found. Set DEVSPACE_PROXY_AUTH_TOKEN or place it in '$configDir\proxy_token.txt'."
}

$devspaceSourceDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$devspaceCli = Join-Path $devspaceSourceDir "dist\cli.js"
$prepareLaunchScript = Join-Path $devspaceSourceDir "scripts\prepare-devspace-launch.ps1"

Write-Host "Preparing local DevSpace build..."
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $prepareLaunchScript -RepositoryRoot $devspaceSourceDir
if ($LASTEXITCODE -ne 0) {
    throw "DevSpace launch preparation failed. The server was not started."
}

if (!(Test-Path $devspaceCli)) {
    throw "DevSpace CLI not found at '$devspaceCli'."
}

# Ensure auth.json exists
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

Start-Process -FilePath "node" -ArgumentList @($devspaceCli, "config", "set", "publicBaseUrl", $PublicProxyBase) -NoNewWindow -Wait | Out-Null

# Start tunnel only after ports are free; DevSpace starts after we know the hostname
# so the live process allowlist always matches the active quick tunnel.
$logFile = Join-Path $env:TEMP "cloudflared_tunnel.log"
$stdoutFile = Join-Path $env:TEMP "cloudflared_stdout.log"
$script:cloudflaredLogFile = $logFile
if (Test-Path $logFile) { Remove-Item $logFile -Force -ErrorAction SilentlyContinue }
if (Test-Path $stdoutFile) { Remove-Item $stdoutFile -Force -ErrorAction SilentlyContinue }

Write-Host "Starting Cloudflare Quick Tunnel..."
$cloudflaredArgs = @(
    "tunnel",
    "--url", "http://${LocalHost}:${LocalPort}",
    "--protocol", "http2",
    "--edge-ip-version", "4",
    "--no-autoupdate",
    "--loglevel", "info"
)
# WMI + cmd redirect: break away from console job AND capture trycloudflare URL from logs.
$cfExe = (Get-Command cloudflared -ErrorAction Stop).Source
$cfLauncher = Join-Path $env:TEMP "cloudflared_launch.cmd"
@(
    "@echo off"
    "`"$cfExe`" tunnel --url http://${LocalHost}:${LocalPort} --protocol http2 --edge-ip-version 4 --no-autoupdate --loglevel info >`"$logFile`" 2>&1"
) | Set-Content -Path $cfLauncher -Encoding ASCII
$cfCreate = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine      = "cmd.exe /c `"$cfLauncher`""
    CurrentDirectory = $PSScriptRoot
}
if ($cfCreate.ReturnValue -eq 0 -and $cfCreate.ProcessId) {
    Write-SetupLog "cloudflared launcher PID=$($cfCreate.ProcessId)"
    # Resolve cloudflared.exe child PID
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 300
        $cf = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
            $_.Name -eq "cloudflared.exe" -and $_.CommandLine -match "127\.0\.0\.1:$LocalPort"
        } | Select-Object -First 1
        if ($cf) {
            $script:cloudflaredProcess = Get-Process -Id $cf.ProcessId -ErrorAction SilentlyContinue
            if ($script:cloudflaredProcess) {
                Write-SetupLog "cloudflared PID=$($cf.ProcessId)"
                break
            }
        }
    }
}
if ($null -eq $script:cloudflaredProcess) {
    Write-SetupLog "WMI cloudflared start failed; using Start-Process." "WARN"
    $script:cloudflaredProcess = Start-Process -FilePath "cloudflared" -ArgumentList $cloudflaredArgs -NoNewWindow -RedirectStandardError $logFile -RedirectStandardOutput $stdoutFile -PassThru
}
if ($null -eq $script:cloudflaredProcess) {
    throw "cloudflared failed to start: no process handle was returned."
}

$tunnelUrl = $null
Write-Host "Waiting for tunnel URL..." -NoNewline
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    Write-Host "." -NoNewline
    if (-not (Test-ManagedProcessAlive $script:cloudflaredProcess)) {
        throw "cloudflared exited before publishing a URL. ExitCode=$(Get-SafeExitCode $script:cloudflaredProcess). See $logFile"
    }
    if (Test-Path $logFile) {
        $logContent = Get-Content $logFile -Raw -ErrorAction SilentlyContinue
        if ($logContent) {
            # Prefer the LAST trycloudflare URL in the log (avoid stale lines from a previous run if log appends).
            $matches = [regex]::Matches($logContent, "https://[a-zA-Z0-9\-]+\.trycloudflare\.com")
            if ($matches.Count -gt 0) {
                $tunnelUrl = $matches[$matches.Count - 1].Value
                Write-Host "`nFound Tunnel URL: $tunnelUrl"
                break
            }
        }
    }
}

if ($null -eq $tunnelUrl) {
    throw "Failed to obtain Cloudflare Tunnel URL. Check Clash/TUN routing or cloudflared logs at $logFile."
}

$tunnelHost = ([System.Uri]$tunnelUrl).Host

# Register BEFORE starting DevSpace so the first healthy proxy probe can succeed once DevSpace is up.
Register-TunnelWithProxy -tunnelUrl $tunnelUrl -authToken $authToken -detectedProxy $detectedProxy

# Start DevSpace with allowlist that includes the fresh tunnel host.
$script:devspaceProcess = Start-DevSpaceServer -devspaceCli $devspaceCli -tunnelHost $tunnelHost

# Re-register after local server is ready (defeats races with other tunnel recyclers).
Register-TunnelWithProxy -tunnelUrl $tunnelUrl -authToken $authToken -detectedProxy $detectedProxy

# Primary readiness signals on Clash/TUN machines:
# 1) cloudflared log shows edge registration (does NOT require host DNS for trycloudflare)
# 2) Worker proxy /healthz returns DevSpace JSON (public path clients actually use)
# Direct curls to *.trycloudflare.com often DNS-timeout on the host and are optional only.
Write-Host "Waiting for Cloudflare edge registration (from cloudflared log)..." -NoNewline
$edgeReady = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    Write-Host "." -NoNewline

    if (-not (Test-ManagedProcessAlive $script:cloudflaredProcess)) {
        throw "Cloudflare Tunnel stopped during startup. ExitCode=$(Get-SafeExitCode $script:cloudflaredProcess). See $logFile"
    }
    if (-not (Test-ManagedProcessAlive $script:devspaceProcess)) {
        # Re-bind if WMI-detached serve is still healthy but the tracked handle went stale/job-killed.
        $cliPath = if ($script:devspaceCliPath) { $script:devspaceCliPath } else { $devspaceCli }
        $rebound = Resolve-DevSpaceServeProcess -ExpectedCliPath $cliPath
        if ($rebound -and (Test-LocalDevSpaceHealthy)) {
            Write-SetupLog "Re-bound DevSpace process handle after stale exit flag: oldPID=$($script:devspaceProcess.Id) newPID=$($rebound.Id)" "WARN"
            $script:devspaceProcess = $rebound
        } else {
            $oldPid = if ($script:devspaceProcess) { $script:devspaceProcess.Id } else { "n/a" }
            $tail = Get-LogTail $script:devspaceStderrLog 40
            throw "DevSpace stopped during startup. PID=$oldPid; ExitCode=$(Get-SafeExitCode $script:devspaceProcess).`n--- stderr tail ---`n$tail"
        }
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

# Optional direct origin probe (may fail under local DNS even when the tunnel works).
Write-Host "Optional direct tunnel probe (may DNS-fail under Clash/TUN)..."
$direct = Get-HttpBody -url "$tunnelUrl/healthz" -timeoutSec 8 -PreferIpv4
if ($direct -match 'devspace') {
    Write-Host "Direct tunnel origin healthy: $direct"
} elseif ($direct -match 'Invalid Host') {
    throw "Tunnel reaches a DevSpace process that rejects Host '$tunnelHost'. Another process may still own port $LocalPort."
} else {
    Write-Warning "Direct trycloudflare probe inconclusive ('$direct'). This is OK if the Worker proxy path works."
}

# Verify the Worker is not still pointing at a dead/stale trycloudflare host.
Write-Host "Verifying public Worker proxy path (this is the required check)..."
if (-not (Test-ProxyUsesTunnel -expectedTunnelHost $tunnelHost -attempts 12)) {
    Write-Warning "Proxy still unhealthy after first registration; re-registering once more..."
    Register-TunnelWithProxy -tunnelUrl $tunnelUrl -authToken $authToken -detectedProxy $detectedProxy
    Start-Sleep -Seconds 2
    if (-not (Test-ProxyUsesTunnel -expectedTunnelHost $tunnelHost -attempts 12)) {
        throw @"
Public MCP proxy health check failed for $PublicProxyBase.
Expected upstream tunnel host: $tunnelHost
Local DevSpace was healthy; cloudflared PID=$(if ($script:cloudflaredProcess) { $script:cloudflaredProcess.Id } else { 'n/a' }) still tracked.
This is a proxy/tunnel coordination failure, NOT process termination.
Likely causes:
  - competing process re-registered a different trycloudflare URL
  - another serve stole port $LocalPort (e.g. chatgpt-push-fs0)
  - Worker /set-tunnel did not stick
See cloudflared log: $logFile
"@
    }
}

Write-Host "`nTesting Discovery Endpoints:"
Write-Host "----------------------------"
$endpoints = @(
    "/.well-known/oauth-protected-resource/mcp"
    "/.well-known/oauth-authorization-server"
)
$discoveryFailed = $false
foreach ($ep in $endpoints) {
    $url = "$PublicProxyBase$ep"
    Write-Host "Testing: $url"
    $response = Get-HttpBody -url $url -timeoutSec 15 -PreferIpv4
    if ([string]::IsNullOrWhiteSpace($response)) {
        Write-Warning "Empty response from $url"
        $discoveryFailed = $true
    } elseif ($response.Trim().StartsWith("<")) {
        Write-Warning "Failed: Endpoint returned HTML instead of JSON."
        $titleMatch = [regex]::Match($response, "(?i)<title>(.*?)</title>")
        if ($titleMatch.Success) {
            Write-Warning "HTML Page Title: $($titleMatch.Groups[1].Value)"
        }
        $stale = [regex]::Match($response, "([a-z0-9-]+\.trycloudflare\.com)")
        if ($stale.Success -and $stale.Groups[1].Value -ne $tunnelHost) {
            Write-Warning "Proxy is still using stale tunnel host '$($stale.Groups[1].Value)' (current is '$tunnelHost')."
        }
        $discoveryFailed = $true
    } elseif ($response -match 'Invalid Host') {
        Write-Warning $response
        $discoveryFailed = $true
    } else {
        Write-Host $response
        if ($response -match "127\.0\.0\.1|localhost|4750") {
            Write-Warning "Found residual localhost values in response."
            $discoveryFailed = $true
        } else {
            Write-Host "Check OK."
        }
    }
    Write-Host "----------------------------`n"
}

if ($discoveryFailed) {
    throw @"
Discovery endpoint checks failed while processes are still running.
DevSpace PID=$(if ($script:devspaceProcess) { $script:devspaceProcess.Id } else { 'n/a' })
cloudflared PID=$(if ($script:cloudflaredProcess) { $script:cloudflaredProcess.Id } else { 'n/a' })
Active tunnel: $tunnelUrl
Public proxy: $PublicProxyBase
This is a proxy/tunnel coordination failure, not a blank process exit.
"@
}

Write-Host "Verifying authenticated MCP tool inventories..."
$authConfig = Get-Content -LiteralPath $authFile -Raw | ConvertFrom-Json
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
    -AccessToken $probeAccessToken
$publicTools = Assert-ExpectedToolInventory -EndpointLabel "Public Worker" -ExpectedTools $ExpectedTools -ActualTools $publicTools

$gitIdentity = Get-DevSpaceGitIdentity -RepositoryRoot $devspaceSourceDir -CliPath $devspaceCli -SetupScriptPath $PSCommandPath
Write-SetupLog "Runtime source: commit=$($gitIdentity.commit) branch=$($gitIdentity.branch) dirty=$($gitIdentity.dirty) dirtyFingerprint=$($gitIdentity.dirtyFingerprintSha256)"
Write-SetupLog "Setup finished. Exact connector tools: $($ExpectedTools -join ', ')."
Write-SetupLog "Public MCP base: $PublicProxyBase"
Write-SetupLog "Active tunnel host: $tunnelHost"
Write-SetupLog "DevSpace PID=$($script:devspaceProcess.Id); cloudflared PID=$($script:cloudflaredProcess.Id)"
Save-RuntimeState `
    -DevSpacePid $script:devspaceProcess.Id `
    -CloudflaredPid $script:cloudflaredProcess.Id `
    -TunnelUrl $tunnelUrl `
    -TunnelHost $tunnelHost `
    -GitIdentity $gitIdentity `
    -LocalTools $localTools `
    -PublicTools $publicTools

Write-Host ""
Write-Host "Live MCP endpoint: $($localTools.Count) tools (localhost and public Worker verified)" -ForegroundColor Green
Write-Host "  Localhost: $($localTools.Count) tools"
Write-Host "  Public Worker: $($publicTools.Count) tools"
Write-Warning "ChatGPT action snapshot may require Refresh or republication after tool changes."
Write-Warning "Existing conversations may retain their previous tool schema; start a new conversation after refreshing the app."

# Default: leave services running in the background and exit cleanly.
# The previous "steady-state monitor" stayed in the same console job; when the
# job/console was torn down (or a sibling agent killed cli.js), Node died with
# ExitCode=null and this script's finally block then killed everything else.
$script:leaveRunning = $true

if (-not $Monitor) {
    Write-Host ""
    Write-Host "DevSpace is running in the background (this window can close)." -ForegroundColor Green
    Write-Host "  Public:  $PublicProxyBase"
    Write-Host "  Tunnel:  $tunnelUrl"
    Write-Host "  PIDs:    devspace=$($script:devspaceProcess.Id) cloudflared=$($script:cloudflaredProcess.Id)"
    Write-Host "  State:   $script:runtimePidFile"
    Write-Host "  Stop:    powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Stop"
    Write-Host "  Monitor: powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Monitor"
    Write-SetupLog "Background mode: leaving processes running; exiting launcher."
} else {
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

        # Re-bind process handles if WMI-launched PIDs were recycled
        if (-not $dsAlive -or -not $localOk) {
            $cliPath = if ($script:devspaceCliPath) { $script:devspaceCliPath } else { $devspaceCli }
            $rebound = Resolve-DevSpaceServeProcess -ExpectedCliPath $cliPath
            if ($rebound) {
                $script:devspaceProcess = $rebound
                $dsAlive = Test-ManagedProcessAlive $script:devspaceProcess
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
} catch {
    if ($script:intentionalStop) {
        Write-SetupLog "Stopped by user."
        $exitCode = 0
        $script:leaveRunning = $false
    } else {
        $exitCode = 1
        $script:leaveRunning = $false
        Write-Host ""
        Write-Host "========== DEVSPACE SETUP/RUNTIME ERROR ==========" -ForegroundColor Red
        Write-Host $_.Exception.Message -ForegroundColor Red
        if ($_.ScriptStackTrace) {
            Write-Host $_.ScriptStackTrace
        }
        Write-Host "==================================================" -ForegroundColor Red
        Write-SetupLog $_.Exception.Message "ERROR"
    }
} finally {
    if ($script:leaveRunning) {
        Write-Host "`nLeaving DevSpace + cloudflared running in background."
    } else {
        Write-Host "`nStopping DevSpace and Cloudflare Tunnel..."
        Stop-TrackedProcesses
        try { Stop-DevSpaceRuntime } catch {}
    }
}

if ($exitCode -ne 0) {
    exit $exitCode
}
