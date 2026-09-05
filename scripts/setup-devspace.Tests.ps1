$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$supportScript = Join-Path $here "setup-devspace-support.ps1"
$lifecycleScript = Join-Path $here "setup-devspace-lifecycle.ps1"
. $supportScript
. $lifecycleScript

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

    It "uses staged recycle only when local origin is down" {
        $d = Get-DevSpaceHealDecision -LocalHealthy $false -WorkerHealthy $false -QuickTunnelAlive $false
        $d.Action | Should Be "staged-recycle"
        $d.PreserveNode | Should Be $false
        $d.PreserveActiveDist | Should Be $false
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
