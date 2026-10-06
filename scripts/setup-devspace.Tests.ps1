$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$supportScript = Join-Path $here "setup-devspace-support.ps1"
$lifecycleScript = Join-Path $here "setup-devspace-lifecycle.ps1"
. $supportScript
. $lifecycleScript

Describe "DevSpace setup script syntax" {
    It "parses the production setup script without PowerShell syntax errors" {
        $setupScript = Join-Path $here "setup-devspace.ps1"
        $tokens = $null
        $errors = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile($setupScript, [ref]$tokens, [ref]$errors)
        @($errors).Count | Should Be 0
    }
}

Describe "DevSpace setup server config preservation" {
    It "preserves chatshare and unrelated config while replacing setup-managed fields" {
        $existing = [pscustomobject]@{
            host                = "old-host"
            port                = 9999
            stateDir            = "C:\custom-state"
            chatSessionProvider = "chatshare"
        }

        $provider = Resolve-DevSpaceChatSessionProvider -ExistingConfig $existing
        $merged = New-DevSpaceServerConfig `
            -ExistingConfig $existing `
            -HostName "127.0.0.1" `
            -Port 7676 `
            -AllowedRoots @("E:\Code") `
            -PublicBaseUrl "https://proxy.example.test" `
            -AllowedHosts @("proxy.example.test", "localhost") `
            -ChatSessionProvider $provider

        $provider | Should Be "chatshare"
        $merged.chatSessionProvider | Should Be "chatshare"
        $merged.stateDir | Should Be "C:\custom-state"
        $merged.host | Should Be "127.0.0.1"
        $merged.port | Should Be 7676
        @($merged.allowedRoots).Count | Should Be 1
        $merged.allowedRoots[0] | Should Be "E:\Code"
        $merged.publicBaseUrl | Should Be "https://proxy.example.test"
    }

    It "lets an explicit environment provider override persisted config" {
        $existing = [pscustomobject]@{ chatSessionProvider = "chatgpt" }
        (Resolve-DevSpaceChatSessionProvider -ExistingConfig $existing -EnvironmentValue "chatshare") | Should Be "chatshare"
    }

    It "defaults to chatgpt only when neither config nor environment selects a provider" {
        (Resolve-DevSpaceChatSessionProvider -ExistingConfig ([pscustomobject]@{})) | Should Be "chatgpt"
    }

    It "rejects an invalid persisted provider instead of silently changing modes" {
        $existing = [pscustomobject]@{ chatSessionProvider = "invalid" }
        { Resolve-DevSpaceChatSessionProvider -ExistingConfig $existing } | Should Throw
    }

    It "passes the resolved provider into the detached production launcher" {
        $setupScript = Get-Content -LiteralPath (Join-Path $here "setup-devspace.ps1") -Raw
        $setupScript | Should Match 'set DEVSPACE_CHAT_SESSION_PROVIDER=\$\(\$env:DEVSPACE_CHAT_SESSION_PROVIDER\)'
    }
}

Describe "DevSpace setup tool inventory assertion" {
    $exactTools = @(
        "bash",
        "close_workspace",
        "edit",
        "open_workspace",
        "publish_git_changes",
        "read",
        "read_files",
        "safe_rename_file",
        "write"
    )

    It "accepts the exact ordinal inventory" {
        { Assert-ExpectedToolInventory -EndpointLabel "test" -ExpectedTools $exactTools -ActualTools $exactTools } | Should Not Throw
    }

    It "rejects case-only tool name changes" {
        $actual = @($exactTools)
        $actual[0] = "BASH"
        { Assert-ExpectedToolInventory -EndpointLabel "test" -ExpectedTools $exactTools -ActualTools $actual } | Should Throw
    }

    It "rejects duplicate tool names" {
        $actual = @($exactTools + "bash")
        { Assert-ExpectedToolInventory -EndpointLabel "test" -ExpectedTools $exactTools -ActualTools $actual } | Should Throw
    }

    It "rejects an extra live tool name as lockstep drift" {
        $actual = @($exactTools + "create_worktree_workspace")
        { Assert-ExpectedToolInventory -EndpointLabel "test" -ExpectedTools $exactTools -ActualTools $actual } | Should Throw
    }

    It "accepts cached inventory only when provenance and all three inventories match exactly" {
        $state = [pscustomobject]@{
            devspacePid   = 1234
            tunnelHost    = "live.trycloudflare.com"
            publicBaseUrl = "https://proxy.example.test"
            source        = [pscustomobject]@{ cliSha256 = "abc123" }
            toolInventory = [pscustomobject]@{
                expected = @($exactTools)
                local    = @($exactTools)
                public   = @($exactTools)
            }
        }
        $cached = Get-DevSpaceValidatedCachedToolInventory `
            -State $state `
            -ExpectedTools $exactTools `
            -ExpectedDevSpacePid 1234 `
            -ExpectedCliSha256 "abc123" `
            -ExpectedTunnelHost "live.trycloudflare.com" `
            -ExpectedPublicBaseUrl "https://proxy.example.test/"
        $cached | Should Not Be $null
        @($cached.Local).Count | Should Be $exactTools.Count
        @($cached.Public).Count | Should Be $exactTools.Count
    }

    It "rejects stale or partial cached inventory" {
        $state = [pscustomobject]@{
            devspacePid   = 1234
            tunnelHost    = "live.trycloudflare.com"
            publicBaseUrl = "https://proxy.example.test"
            source        = [pscustomobject]@{ cliSha256 = "abc123" }
            toolInventory = [pscustomobject]@{
                expected = @($exactTools)
                local    = @($exactTools)
                public   = @($exactTools | Select-Object -Skip 1)
            }
        }
        (Get-DevSpaceValidatedCachedToolInventory -State $state -ExpectedTools $exactTools -ExpectedDevSpacePid 1234 -ExpectedCliSha256 "abc123" -ExpectedTunnelHost "live.trycloudflare.com" -ExpectedPublicBaseUrl "https://proxy.example.test") | Should Be $null

        $state.toolInventory.public = @($exactTools)
        (Get-DevSpaceValidatedCachedToolInventory -State $state -ExpectedTools $exactTools -ExpectedDevSpacePid 9999 -ExpectedCliSha256 "abc123" -ExpectedTunnelHost "live.trycloudflare.com" -ExpectedPublicBaseUrl "https://proxy.example.test") | Should Be $null
        (Get-DevSpaceValidatedCachedToolInventory -State $state -ExpectedTools $exactTools -ExpectedDevSpacePid 1234 -ExpectedCliSha256 "different" -ExpectedTunnelHost "live.trycloudflare.com" -ExpectedPublicBaseUrl "https://proxy.example.test") | Should Be $null
        (Get-DevSpaceValidatedCachedToolInventory -State $state -ExpectedTools $exactTools -ExpectedDevSpacePid 1234 -ExpectedCliSha256 "abc123" -ExpectedTunnelHost "other.trycloudflare.com" -ExpectedPublicBaseUrl "https://proxy.example.test") | Should Be $null
    }
}

Describe "DevSpace setup probe client persistence" {
    BeforeEach {
        $testDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("devspace-probe-test-" + [Guid]::NewGuid().ToString("N"))
        $clientFile = Join-Path $testDirectory "probe-client.json"
        $localBaseUrl = "http://127.0.0.1:7676"
        $redirectUri = "http://127.0.0.1:17676/callback"
    }

    AfterEach {
        Remove-Item -LiteralPath $testDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }

    It "registers once, persists the dedicated client, and reuses it" {
        $script:registrationCount = 0
        $registrationAction = {
            param($baseUrl, $callbackUri)
            $script:registrationCount++
            [pscustomobject]@{
                client_id = "devspace-probe-client"
                client_secret = "probe-secret"
            }
        }

        $first = Resolve-DevSpaceProbeClient `
            -ClientFile $clientFile `
            -LocalBaseUrl $localBaseUrl `
            -RedirectUri $redirectUri `
            -RegistrationAction $registrationAction
        $second = Resolve-DevSpaceProbeClient `
            -ClientFile $clientFile `
            -LocalBaseUrl $localBaseUrl `
            -RedirectUri $redirectUri `
            -RegistrationAction { throw "registration must not run for a valid persisted client" }

        $script:registrationCount | Should Be 1
        $first.Reused | Should Be $false
        $second.Reused | Should Be $true
        $second.Client.client_id | Should Be "devspace-probe-client"
        $second.Client.client_secret | Should Be "probe-secret"
    }

    It "rejects persisted metadata for a different local endpoint" {
        Save-PersistedDevSpaceProbeClient `
            -ClientFile $clientFile `
            -LocalBaseUrl $localBaseUrl `
            -RedirectUri $redirectUri `
            -Client ([pscustomobject]@{ client_id = "old"; client_secret = "old-secret" })

        $loaded = Get-PersistedDevSpaceProbeClient `
            -ClientFile $clientFile `
            -LocalBaseUrl "http://localhost:7676" `
            -RedirectUri $redirectUri

        $loaded | Should Be $null
    }
}


Describe "DevSpace healthz JSON schema" {
    It "accepts explicit ok=true and name=devspace" {
        Test-DevSpaceHealthzJson '{"ok":true,"name":"devspace"}' | Should Be $true
    }

    It "rejects a substring match that is not the schema" {
        Test-DevSpaceHealthzJson '<html>devspace 530</html>' | Should Be $false
        Test-DevSpaceHealthzJson '{"ok":true,"name":"other"}' | Should Be $false
        Test-DevSpaceHealthzJson '{"ok":"true","name":"devspace"}' | Should Be $false
        Test-DevSpaceHealthzJson '{"name":"devspace"}' | Should Be $false
        Test-DevSpaceHealthzJson '' | Should Be $false
    }
}

Describe "DevSpace discovery document validation" {
    $base = "https://devspace.example.test"

    It "accepts canonical protected-resource and authorization metadata" {
        $protected = '{"resource":"https://devspace.example.test/mcp","authorization_servers":["https://devspace.example.test/"]}'
        $authorization = '{"issuer":"https://devspace.example.test/","authorization_endpoint":"https://devspace.example.test/authorize","token_endpoint":"https://devspace.example.test/token","registration_endpoint":"https://devspace.example.test/register"}'

        Test-DevSpaceDiscoveryDocument -Path "/.well-known/oauth-protected-resource/mcp" -Body $protected -PublicBaseUrl $base | Should Be $true
        Test-DevSpaceDiscoveryDocument -Path "/.well-known/oauth-authorization-server" -Body $authorization -PublicBaseUrl $base | Should Be $true
        Test-DevSpaceDiscoveryDocument -Path "/.well-known/openid-configuration" -Body $authorization -PublicBaseUrl $base | Should Be $true
    }

    It "rejects syntactically valid JSON that points OAuth at the wrong origin" {
        $wrong = '{"issuer":"https://evil.example/","authorization_endpoint":"https://evil.example/authorize","token_endpoint":"https://evil.example/token","registration_endpoint":"https://evil.example/register"}'
        Test-DevSpaceDiscoveryDocument -Path "/.well-known/oauth-authorization-server" -Body $wrong -PublicBaseUrl $base | Should Be $false
        Test-DevSpaceDiscoveryDocument -Path "/.well-known/openid-configuration" -Body $wrong -PublicBaseUrl $base | Should Be $false
    }

    It "rejects Cloudflare errors and malformed protected-resource metadata" {
        Test-DevSpaceDiscoveryDocument -Path "/.well-known/oauth-protected-resource/mcp" -Body "error code: 1016" -PublicBaseUrl $base | Should Be $false
        Test-DevSpaceDiscoveryDocument -Path "/.well-known/oauth-protected-resource/mcp" -Body '{"resource":"https://other.example/mcp","authorization_servers":["https://devspace.example.test/"]}' -PublicBaseUrl $base | Should Be $false
    }
}

Describe "DevSpace heal decision" {
    It "no-ops when local and Worker are healthy" {
        $d = Get-DevSpaceHealDecision -LocalHealthy $true -WorkerHealthy $true -QuickTunnelAlive $true
        $d.Action | Should Be "noop"
        $d.PreserveNode | Should Be $true
        $d.PreserveActiveDist | Should Be $true
        $d.PreserveTunnelHostname | Should Be $true
    }

    It "reregisters a live quick tunnel without touching Node" {
        $d = Get-DevSpaceHealDecision -LocalHealthy $true -WorkerHealthy $false -QuickTunnelAlive $true
        $d.Action | Should Be "reregister"
        $d.PreserveNode | Should Be $true
        $d.PreserveActiveDist | Should Be $true
        $d.PreserveTunnelHostname | Should Be $true
    }

    It "restarts only cloudflared when the quick tunnel is dead" {
        $d = Get-DevSpaceHealDecision -LocalHealthy $true -WorkerHealthy $false -QuickTunnelAlive $false
        $d.Action | Should Be "restart-tunnel"
        $d.PreserveNode | Should Be $true
        $d.PreserveActiveDist | Should Be $true
        $d.PreserveTunnelHostname | Should Be $false
    }

    It "uses staged recycle when local origin is down" {
        $d = Get-DevSpaceHealDecision -LocalHealthy $false -WorkerHealthy $false -QuickTunnelAlive $false
        $d.Action | Should Be "staged-recycle"
        $d.PreserveNode | Should Be $false
        $d.PreserveActiveDist | Should Be $false
    }

    It "force-recycles a healthy origin only when explicitly requested" {
        $d = Get-DevSpaceHealDecision -LocalHealthy $true -WorkerHealthy $true -QuickTunnelAlive $true -ForceRecycle
        $d.Action | Should Be "staged-recycle"
        $d.PreserveNode | Should Be $false
        $d.PreserveActiveDist | Should Be $false
        $d.PreserveTunnelHostname | Should Be $false
    }
}

Describe "DevSpace failure disposition" {
    It "preserves a healthy origin after extra-check failure" {
        $d = Get-DevSpaceFailureDisposition -LocalHealthy $true
        $d.LeaveRunning | Should Be $true
        $d.PreserveOrigin | Should Be $true
        $d.ExitCode | Should Be 1
    }

    It "stops only when the origin is already down" {
        $d = Get-DevSpaceFailureDisposition -LocalHealthy $false
        $d.LeaveRunning | Should Be $false
        $d.PreserveOrigin | Should Be $false
        $d.ExitCode | Should Be 1
    }

    It "stops on intentional Ctrl+C even if local is healthy" {
        $d = Get-DevSpaceFailureDisposition -IntentionalStop -LocalHealthy $true
        $d.LeaveRunning | Should Be $false
        $d.ExitCode | Should Be 0
    }
}

Describe "DevSpace exclusive setup lock" {
    $testDirectory = $null

    BeforeEach {
        $testDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("devspace-lock-test-" + [Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $testDirectory -Force | Out-Null
    }

    AfterEach {
        Remove-Item -LiteralPath $testDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }

    It "allows only one mutator and refuses a second live holder" {
        $lockPath = Join-Path $testDirectory "setup.lock"
        $first = Enter-DevSpaceSetupLock -LockPath $lockPath -WaitSeconds 1 -HolderPid $PID
        $first.Pid | Should Be $PID
        { Enter-DevSpaceSetupLock -LockPath $lockPath -WaitSeconds 1 -HolderPid $PID } | Should Throw
        Exit-DevSpaceSetupLock -LockPath $lockPath -HolderPid $PID
        $second = Enter-DevSpaceSetupLock -LockPath $lockPath -WaitSeconds 1 -HolderPid $PID
        $second.Pid | Should Be $PID
        Exit-DevSpaceSetupLock -LockPath $lockPath -HolderPid $PID
    }

    It "steals a lock whose holder PID is dead" {
        $lockPath = Join-Path $testDirectory "setup.lock"
        @{ pid = 999999991; startedAt = (Get-Date).ToString("o") } | ConvertTo-Json | Set-Content -LiteralPath $lockPath -Encoding UTF8
        $stolen = Enter-DevSpaceSetupLock -LockPath $lockPath -WaitSeconds 2 -HolderPid $PID
        $stolen.Pid | Should Be $PID
        Exit-DevSpaceSetupLock -LockPath $lockPath -HolderPid $PID
    }
}

Describe "DevSpace preferred source fail-closed" {
    $testDirectory = $null

    BeforeEach {
        $testDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("devspace-pin-test-" + [Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $testDirectory -Force | Out-Null
    }

    AfterEach {
        Remove-Item -LiteralPath $testDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }

    It "treats a .worktrees path as a worktree" {
        $worktree = Join-Path $testDirectory ".worktrees\task-one"
        New-Item -ItemType Directory -Path $worktree -Force | Out-Null
        Test-DevSpaceGitWorktreePath $worktree | Should Be $true
    }

    It "treats a .git file as a linked worktree" {
        $worktree = Join-Path $testDirectory "linked"
        New-Item -ItemType Directory -Path $worktree -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $worktree ".git") -Value "gitdir: C:\repo\.git\worktrees\linked" -Encoding ASCII
        Test-DevSpaceGitWorktreePath $worktree | Should Be $true
    }

    It "refuses a missing pin" {
        $approved = Join-Path $testDirectory "canonical"
        New-Item -ItemType Directory -Path $approved -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $approved ".git") -Force | Out-Null
        { Assert-DevSpacePreferredRuntimeSource -ApprovedCheckout $approved -PinPath (Join-Path $testDirectory "missing.json") } | Should Throw
    }

    It "refuses a pin that points at a worktree" {
        $approved = Join-Path $testDirectory "canonical"
        $worktree = Join-Path $testDirectory ".worktrees\task-one"
        New-Item -ItemType Directory -Path $approved -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $approved ".git") -Force | Out-Null
        New-Item -ItemType Directory -Path $worktree -Force | Out-Null
        $pinPath = Join-Path $testDirectory "preferred-runtime-source.json"
        @{ repository = $worktree; requireClean = $true } | ConvertTo-Json | Set-Content -LiteralPath $pinPath -Encoding UTF8
        { Assert-DevSpacePreferredRuntimeSource -ApprovedCheckout $approved -PinPath $pinPath } | Should Throw
    }

    It "refuses a pin whose repository is missing" {
        $approved = Join-Path $testDirectory "canonical"
        New-Item -ItemType Directory -Path $approved -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $approved ".git") -Force | Out-Null
        $pinPath = Join-Path $testDirectory "preferred-runtime-source.json"
        @{ repository = (Join-Path $testDirectory "gone"); requireClean = $true } | ConvertTo-Json | Set-Content -LiteralPath $pinPath -Encoding UTF8
        { Assert-DevSpacePreferredRuntimeSource -ApprovedCheckout $approved -PinPath $pinPath } | Should Throw
    }

    It "accepts a pin that matches the approved checkout" {
        $approved = Join-Path $testDirectory "canonical"
        New-Item -ItemType Directory -Path $approved -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $approved ".git") -Force | Out-Null
        $pinPath = Join-Path $testDirectory "preferred-runtime-source.json"
        Save-DevSpacePreferredRuntimeSource -PinPath $pinPath -Repository $approved
        $pin = Assert-DevSpacePreferredRuntimeSource -ApprovedCheckout $approved -PinPath $pinPath
        (ConvertTo-NormalizedDevSpacePath $pin.repository) | Should Be (ConvertTo-NormalizedDevSpacePath $approved)
    }

    It "does not block staged recycle when the pinned checkout is dirty" {
        $repo = Join-Path $testDirectory "dirty-recycle"
        New-Item -ItemType Directory -Path $repo -Force | Out-Null
        & git -C $repo init --quiet
        Set-Content -LiteralPath (Join-Path $repo "dirty.txt") -Value "untracked" -Encoding ASCII
        $pin = [pscustomobject]@{ requireClean = $true }
        { Assert-DevSpaceSourceCleanForRecycle -Repository $repo -Pin $pin } | Should Not Throw
    }
}

Describe "DevSpace proxy tunnel readiness classification" {
    $expectedHost = "cheaper-rpm-karl-more.trycloudflare.com"

    It "treats valid DevSpace JSON as healthy" {
        $observation = Get-DevSpaceProxyHealthObservation `
            -Body '{"ok":true,"name":"devspace"}' `
            -ExpectedTunnelHost $expectedHost
        $observation.Kind | Should Be "healthy"
    }

    It "treats Cloudflare HTML naming the expected host as a wait condition" {
        $body = "<html><head><title>Origin DNS error | Cloudflare</title></head><body>$expectedHost</body></html>"
        $observation = Get-DevSpaceProxyHealthObservation -Body $body -ExpectedTunnelHost $expectedHost
        $observation.Kind | Should Be "expected-upstream-not-ready"
        $observation.SeenHost | Should Be $expectedHost
    }

    It "distinguishes a genuinely stale Worker upstream" {
        $body = "<html><head><title>Origin DNS error | Cloudflare</title></head><body>old-host.trycloudflare.com</body></html>"
        $observation = Get-DevSpaceProxyHealthObservation -Body $body -ExpectedTunnelHost $expectedHost
        $observation.Kind | Should Be "stale-upstream"
        $observation.SeenHost | Should Be "old-host.trycloudflare.com"
    }

    It "does not mistake an expected-host allowlist rejection for DNS warmup" {
        $observation = Get-DevSpaceProxyHealthObservation `
            -Body "Invalid Host: $expectedHost" `
            -ExpectedTunnelHost $expectedHost
        $observation.Kind | Should Be "invalid-host"
        $observation.SeenHost | Should Be $expectedHost
    }

    It "treats plain Cloudflare 1016 text as a wait condition, not health" {
        $observation = Get-DevSpaceProxyHealthObservation `
            -Body "error code: 1016" `
            -ExpectedTunnelHost $expectedHost
        $observation.Kind | Should Be "expected-upstream-not-ready"
        Test-DevSpaceCloudflareUpstreamFailure -Body "error code: 1016" -StatusCode 530 | Should Be $true
        Test-DevSpaceDiscoveryBodyOk -Body "error code: 1016" | Should Be $false
        Test-DevSpaceDiscoveryBodyOk -Body '{"resource":"https://example.com/mcp"}' | Should Be $true
    }

    It "treats unauthenticated POST /mcp 401 as origin reached and 530/1016 as not reached" {
        Test-DevSpacePublicMcpReachedOrigin -StatusCode 401 -Body '{"error":"invalid_token","error_description":"Missing Authorization header"}' | Should Be $true
        Test-DevSpacePublicMcpReachedOrigin -StatusCode 530 -Body "error code: 1016" | Should Be $false
        Test-DevSpacePublicMcpReachedOrigin -StatusCode 200 -Body '{"ok":true,"name":"devspace"}' | Should Be $true
        Test-DevSpaceHealthzJson '{"ok":true,"name":"devspace"}' | Should Be $true
        Test-DevSpacePublicMcpReachedOrigin -StatusCode 200 -Body '{"ok":true,"name":"devspace"}' | Should Be $true
    }

    It "treats transient gateway statuses as public-path failures even with empty bodies" {
        Test-DevSpaceCloudflareUpstreamFailure -StatusCode 502 -Body "" | Should Be $true
        Test-DevSpaceCloudflareUpstreamFailure -StatusCode 503 -Body "" | Should Be $true
        Test-DevSpaceCloudflareUpstreamFailure -StatusCode 524 -Body "" | Should Be $true
        Test-DevSpacePublicMcpReachedOrigin -StatusCode 502 -Body "" | Should Be $false
    }
}

Describe "DevSpace public-path self-heal" {
    $now = [datetime]::SpecifyKind([datetime]"2026-09-14T20:30:00", "Utc")

    It "reboots origin only when local healthz is down" {
        $d = Get-DevSpacePublicPathHealDecision -LocalHealthy $false -PublicMcpReachedOrigin $false -QuickTunnelAlive $true -NowUtc $now
        $d.Action | Should Be "reboot-origin"
        $d.PreserveNode | Should Be $false
    }

    It "does not reboot a healthy origin for public 502/530" {
        $d = Get-DevSpacePublicPathHealDecision -LocalHealthy $true -PublicMcpReachedOrigin $false -QuickTunnelAlive $true -NowUtc $now
        $d.Action | Should Be "restart-tunnel"
        $d.PreserveNode | Should Be $true
    }

    It "no-ops when POST /mcp already reached origin" {
        $d = Get-DevSpacePublicPathHealDecision -LocalHealthy $true -PublicMcpReachedOrigin $true -QuickTunnelAlive $true -NowUtc $now
        $d.Action | Should Be "noop"
        $d.PreserveNode | Should Be $true
    }

    It "reregisters only during trycloudflare remint cooldown" {
        $d = Get-DevSpacePublicPathHealDecision `
            -LocalHealthy $true `
            -PublicMcpReachedOrigin $false `
            -QuickTunnelAlive $true `
            -LastTunnelRestartUtc $now.AddMinutes(-2) `
            -NowUtc $now
        $d.Action | Should Be "reregister"
        $d.PreserveNode | Should Be $true
    }

    It "does not treat an inconclusive POST /mcp probe as 502" {
        Get-DevSpacePublicMcpProbeKind -StatusCode 0 -Body "" | Should Be "unknown"
        Get-DevSpacePublicMcpProbeKind -StatusCode 401 -Body "" | Should Be "reached"
        Get-DevSpacePublicMcpProbeKind -StatusCode 530 -Body "error code: 1016" | Should Be "upstream-failure"
        $d = Get-DevSpacePublicPathHealDecision `
            -LocalHealthy $true `
            -PublicMcpKind "unknown" `
            -QuickTunnelAlive $true `
            -NowUtc $now
        $d.Action | Should Be "noop"
        $d.PreserveNode | Should Be $true
    }
}

Describe "DevSpace quick tunnel custody" {
    $testDirectory = $null

    BeforeEach {
        $testDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("devspace-tunnel-custody-test-" + [Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $testDirectory -Force | Out-Null
    }

    AfterEach {
        Remove-Item -LiteralPath $testDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }

    It "parses the live cloudflared logfile from its command line" {
        $commandLine = '"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://127.0.0.1:7676 --logfile "C:\Users\Lenovo\AppData\Local\Temp\cloudflared_tunnel_live.log"'
        Get-DevSpaceCloudflaredLogFileFromCommandLine -CommandLine $commandLine | Should Be "C:\Users\Lenovo\AppData\Local\Temp\cloudflared_tunnel_live.log"
    }

    It "atomically replaces tunnel custody while preserving unrelated runtime fields" {
        $runtimeFile = Join-Path $testDirectory "runtime.json"
        @{
            devspacePid    = 2512
            cloudflaredPid = 2788
            tunnelUrl      = "https://dead-old.trycloudflare.com"
            tunnelHost     = "dead-old.trycloudflare.com"
            source         = @{ commit = "keep-me" }
        } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $runtimeFile -Encoding UTF8

        Update-DevSpaceTunnelCustodyFile `
            -RuntimeFile $runtimeFile `
            -TunnelUrl "https://cheaper-rpm-karl-more.trycloudflare.com" `
            -TunnelHost "cheaper-rpm-karl-more.trycloudflare.com" `
            -CloudflaredPid 20748 `
            -CloudflaredLog "C:\Temp\cloudflared-live.log" `
            -DevSpacePid 2512 `
            -PublicBaseUrl "https://devspace-proxy.kitlongku.workers.dev" | Out-Null

        $loaded = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
        $loaded.tunnelUrl | Should Be "https://cheaper-rpm-karl-more.trycloudflare.com"
        $loaded.tunnelHost | Should Be "cheaper-rpm-karl-more.trycloudflare.com"
        $loaded.cloudflaredPid | Should Be 20748
        $loaded.cloudflaredLog | Should Be "C:\Temp\cloudflared-live.log"
        $loaded.devspacePid | Should Be 2512
        $loaded.source.commit | Should Be "keep-me"
        $loaded.tunnelPublishedAt | Should Not Be $null
    }

    It "refuses to overwrite unreadable runtime custody" {
        $runtimeFile = Join-Path $testDirectory "runtime.json"
        Set-Content -LiteralPath $runtimeFile -Value "{not-json" -Encoding ASCII
        {
            Update-DevSpaceTunnelCustodyFile `
                -RuntimeFile $runtimeFile `
                -TunnelUrl "https://cheaper-rpm-karl-more.trycloudflare.com" `
                -TunnelHost "cheaper-rpm-karl-more.trycloudflare.com" `
                -CloudflaredPid 20748
        } | Should Throw
        (Get-Content -LiteralPath $runtimeFile -Raw).Trim() | Should Be "{not-json"
    }

    It "includes supervisor logs even when runtime.json still names a dead cloudflared PID" {
        $runtimeFile = Join-Path $testDirectory "runtime.json"
        $supervisorConfig = Join-Path $testDirectory "supervisor.json"
        $staleLog = Join-Path $testDirectory "stale-temp.log"
        $supervisorLog = Join-Path $testDirectory "quick-tunnel-stderr.log"
        Set-Content -LiteralPath $staleLog -Value "https://regular-viking-commodity-motors.trycloudflare.com" -Encoding ASCII
        Set-Content -LiteralPath $supervisorLog -Value "https://present-exp-parker-rebecca.trycloudflare.com" -Encoding ASCII
        @{
            cloudflaredPid = 23112
            cloudflaredLog = $staleLog
            tunnelUrl      = "https://regular-viking-commodity-motors.trycloudflare.com"
        } | ConvertTo-Json | Set-Content -LiteralPath $runtimeFile -Encoding UTF8
        @{
            quickTunnelStderrLog = $supervisorLog
        } | ConvertTo-Json | Set-Content -LiteralPath $supervisorConfig -Encoding UTF8

        $files = @(
            Get-DevSpaceKnownCloudflaredLogFiles `
                -RuntimeFile $runtimeFile `
                -SupervisorConfigPath $supervisorConfig
        )
        $files -contains $supervisorLog | Should Be $true
        $files -contains $staleLog | Should Be $true

        Start-Sleep -Milliseconds 20
        Set-Content -LiteralPath $supervisorLog -Value "|  https://present-exp-parker-rebecca.trycloudflare.com  |" -Encoding ASCII
        $recovered = Get-DevSpaceQuickTunnelUrlFromLogFiles -LogFiles $files
        $recovered.TunnelUrl | Should Be "https://present-exp-parker-rebecca.trycloudflare.com"
        $recovered.LogFile | Should Be $supervisorLog
    }

    It "prefers the newest logfile URL when cloudflared has scrubbed its command line" {
        $older = Join-Path $testDirectory "older.log"
        $newer = Join-Path $testDirectory "newer.log"
        Set-Content -LiteralPath $older -Value "https://dead-old.trycloudflare.com" -Encoding ASCII
        Start-Sleep -Milliseconds 20
        Set-Content -LiteralPath $newer -Value "https://present-exp-parker-rebecca.trycloudflare.com" -Encoding ASCII
        $recovered = Get-DevSpaceQuickTunnelUrlFromLogFiles -LogFiles @($older, $newer)
        $recovered.TunnelUrl | Should Be "https://present-exp-parker-rebecca.trycloudflare.com"
        $recovered.LogFile | Should Be $newer
    }
}

Describe "DevSpace origin process matching" {
    It "matches a serve command line on the canonical dist CLI" {
        $record = [pscustomobject]@{
            Name        = "node.exe"
            ProcessId   = 126044
            CommandLine = 'D:\nodejs\node.exe E:\Code\devspace\devspace-src\dist\cli.js serve'
        }
        Test-DevSpaceOriginRecord -Record $record | Should Be $true
    }

    It "matches a scrubbed node command line when it owns the origin listener" {
        $record = [pscustomobject]@{
            Name        = "node.exe"
            ProcessId   = 126044
            CommandLine = ""
        }
        Test-DevSpaceOriginRecord -Record $record -ListenerPid 126044 | Should Be $true
    }

    It "does not treat an unrelated scrubbed node process as the origin" {
        $record = [pscustomobject]@{
            Name        = "node.exe"
            ProcessId   = 99
            CommandLine = ""
        }
        Test-DevSpaceOriginRecord -Record $record -ListenerPid 126044 | Should Be $false
    }

    It "rejects a non-node listener owner" {
        $record = [pscustomobject]@{
            Name        = "cloudflared.exe"
            ProcessId   = 126044
            CommandLine = ""
        }
        Test-DevSpaceOriginRecord -Record $record -ListenerPid 126044 | Should Be $false
    }
}

Describe "DevSpace cloudflared process matching" {
    It "matches a command line that targets the origin port" {
        $record = [pscustomobject]@{
            Name        = "cloudflared.exe"
            ProcessId   = 42
            CommandLine = "cloudflared.exe tunnel --url http://127.0.0.1:7676"
        }
        Test-DevSpaceCloudflaredRecord -Record $record -LocalPort 7676 | Should Be $true
    }

    It "rejects a command line aimed at a different port" {
        $record = [pscustomobject]@{
            Name        = "cloudflared.exe"
            ProcessId   = 42
            CommandLine = "cloudflared.exe tunnel --url http://127.0.0.1:8080"
        }
        Test-DevSpaceCloudflaredRecord -Record $record -LocalPort 7676 | Should Be $false
    }

    It "rejects a scrubbed command line without remembered PID ownership" {
        $record = [pscustomobject]@{
            Name        = "cloudflared.exe"
            ProcessId   = 36380
            CommandLine = ""
        }
        Test-DevSpaceCloudflaredRecord -Record $record -LocalPort 7676 | Should Be $false
        Test-DevSpaceCloudflaredRecord -Record $record -LocalPort 7676 -RememberedPid 36380 | Should Be $true
    }

    It "matches a remembered PID even when the command line no longer contains the port" {
        $record = [pscustomobject]@{
            Name        = "cloudflared.exe"
            ProcessId   = 36380
            CommandLine = "cloudflared.exe tunnel run other-name"
        }
        Test-DevSpaceCloudflaredRecord -Record $record -LocalPort 7676 -RememberedPid 36380 | Should Be $true
    }

    It "rejects a non-cloudflared process" {
        $record = [pscustomobject]@{
            Name        = "node.exe"
            ProcessId   = 1
            CommandLine = ""
        }
        Test-DevSpaceCloudflaredRecord -Record $record -LocalPort 7676 | Should Be $false
    }
}

Describe "DevSpace cloudflared launch command" {
    It "invokes cloudflared.exe directly with --logfile and no cmd redirection" {
        $cmd = Get-DevSpaceCloudflaredLaunchCommand `
            -Executable "C:\Program Files (x86)\cloudflared\cloudflared.exe" `
            -LocalHost "127.0.0.1" `
            -LocalPort 7676 `
            -LogFile "C:\Users\Lenovo\AppData\Local\Temp\cloudflared_tunnel_1.log"
        $cmd | Should Match ([regex]::Escape('"C:\Program Files (x86)\cloudflared\cloudflared.exe"'))
        $cmd | Should Match ([regex]::Escape("--url http://127.0.0.1:7676"))
        $cmd | Should Match "--logfile"
        $cmd | Should Not Match "cmd\.exe"
        $cmd | Should Not Match " 2>&1"
        $cmd.StartsWith("cmd.exe") | Should Be $false
    }
}

Describe "DevSpace dist snapshot rollback" {
    $testDirectory = $null

    BeforeEach {
        $testDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("devspace-dist-test-" + [Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $testDirectory -Force | Out-Null
    }

    AfterEach {
        Remove-Item -LiteralPath $testDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }

    It "snapshots and restores dist without requiring atomic directory replace" {
        $dist = Join-Path $testDirectory "dist"
        $snapshot = Join-Path $testDirectory "dist-previous"
        New-Item -ItemType Directory -Path $dist -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $dist "cli.js") -Value "old-artifact" -Encoding ASCII
        Copy-DevSpaceDistSnapshot -DistDirectory $dist -SnapshotDirectory $snapshot | Should Be $true
        Set-Content -LiteralPath (Join-Path $dist "cli.js") -Value "new-broken" -Encoding ASCII
        Restore-DevSpaceDistSnapshot -DistDirectory $dist -SnapshotDirectory $snapshot | Should Be $true
        (Get-Content -LiteralPath (Join-Path $dist "cli.js") -Raw).Trim() | Should Be "old-artifact"
        Get-DevSpaceDistFingerprint -CliPath (Join-Path $dist "cli.js") | Should Not Be $null
    }
}
