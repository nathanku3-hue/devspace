$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$supportScript = Join-Path $here "setup-devspace-support.ps1"
. $supportScript

Describe "DevSpace setup tool inventory assertion" {
    # Exact 20-tool LONG-TASK-CONTROL-1 inventory (must match setup-devspace.ps1 $ExpectedTools).
    $exactTools = @(
        "bash",
        "cancel_long_task",
        "close_workspace",
        "edit",
        "long_task_status",
        "open_workspace",
        "publish_git_changes",
        "read",
        "read_files",
        "review_start",
        "review_status",
        "review_submit",
        "safe_rename_file",
        "start_long_task",
        "validate_task",
        "web_connector_probe",
        "web_connector_start",
        "web_connector_status",
        "web_launch",
        "write"
    )
    $legacySeventeenTools = @(
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
        "validate_task",
        "web_connector_probe",
        "web_connector_start",
        "web_connector_status",
        "web_launch",
        "write"
    )

    It "accepts the exact ordinal inventory" {
        { Assert-ExpectedToolInventory -EndpointLabel "test" -ExpectedTools $exactTools -ActualTools $exactTools } | Should Not Throw
    }

    It "accepts the exact 20-tool LONG-TASK-CONTROL-1 inventory" {
        $exactTools.Count | Should Be 20
        $result = Assert-ExpectedToolInventory -EndpointLabel "test" -ExpectedTools $exactTools -ActualTools $exactTools
        $result.Count | Should Be 20
        @($result) -contains "start_long_task" | Should Be $true
        @($result) -contains "long_task_status" | Should Be $true
        @($result) -contains "cancel_long_task" | Should Be $true
    }

    It "rejects the legacy 17-tool inventory when actual exposes long-task tools" {
        { Assert-ExpectedToolInventory `
            -EndpointLabel "test" `
            -ExpectedTools $legacySeventeenTools `
            -ActualTools $exactTools } | Should Throw
    }

    It "rejects a subset inventory that omits long-task tools" {
        { Assert-ExpectedToolInventory `
            -EndpointLabel "test" `
            -ExpectedTools $exactTools `
            -ActualTools $legacySeventeenTools } | Should Throw
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

Describe "DevSpace runtime process custody" {
    $expectedCli = "E:\Code\devspace\devspace-src\.worktrees\devspace-native\dist\cli.js"
    $startedAt = [DateTime]::SpecifyKind([DateTime]::Parse("2026-08-05T01:00:00"), [DateTimeKind]::Utc)

    It "prefers the exact expected CLI path when multiple cli.js serve processes exist" {
        $processes = @(
            [pscustomobject]@{
                ProcessId = 101
                CommandLine = '"D:\nodejs\node.exe" "E:\Code\devspace\devspace-src\.worktrees\other\dist\cli.js" serve'
                CreationDate = $startedAt
            },
            [pscustomobject]@{
                ProcessId = 202
                CommandLine = '"D:\nodejs\node.exe" "E:\Code\devspace\devspace-src\.worktrees\devspace-native\dist\cli.js" serve'
                CreationDate = $startedAt.AddSeconds(1)
            }
        )

        $resolved = Select-DevSpaceServeProcess `
            -Processes $processes `
            -ExpectedCliPath $expectedCli `
            -ListenerProcessId 202 `
            -HealthVerified $true

        $resolved.ProcessId | Should Be 202
        $resolved.Resolution | Should Be "exact-cli-listener"
        $resolved.CliPath | Should Be $expectedCli
    }

    It "uses the health-verified port owner as the fallback listener" {
        $actualCli = "E:\Code\devspace\devspace-src\.worktrees\devspace-live\dist\cli.js"
        $processes = @(
            [pscustomobject]@{
                ProcessId = 303
                CommandLine = "`"D:\nodejs\node.exe`" `"$actualCli`" serve"
                CreationDate = $startedAt
            }
        )

        $resolved = Select-DevSpaceServeProcess `
            -Processes $processes `
            -ExpectedCliPath $expectedCli `
            -ListenerProcessId 303 `
            -HealthVerified $true

        $resolved.ProcessId | Should Be 303
        $resolved.Resolution | Should Be "health-verified-port-owner"
        $resolved.CliPath | Should Be $actualCli
    }

    It "resolves a hung port owner via CLI path without /healthz" {
        $actualCli = "E:\Code\devspace\devspace-src\.worktrees\devspace-hung\dist\cli.js"
        $processes = @(
            [pscustomobject]@{
                ProcessId = 707
                CommandLine = "`"D:\nodejs\node.exe`" `"$actualCli`" serve"
                CreationDate = $startedAt
            }
        )

        $resolved = Select-DevSpaceServeProcess `
            -Processes $processes `
            -ExpectedCliPath $expectedCli `
            -ListenerProcessId 707 `
            -HealthVerified $false

        $resolved.ProcessId | Should Be 707
        $resolved.Resolution | Should Be "cli-path-port-owner"
        $resolved.CliPath | Should Be $actualCli
        (Test-DevSpacePortOwnerStopAllowed `
            -ListenerProcessId 707 `
            -HealthyListener $false `
            -ResolvedProcess $resolved) | Should Be $true
    }

    It "refuses cleanup when the port owner is neither healthy nor a DevSpace CLI" {
        $processes = @(
            [pscustomobject]@{
                ProcessId = 808
                CommandLine = '"D:\tools\other.exe" --listen 7676'
                CreationDate = $startedAt
            }
        )

        $resolved = Select-DevSpaceServeProcess `
            -Processes $processes `
            -ExpectedCliPath $expectedCli `
            -ListenerProcessId 808 `
            -HealthVerified $false

        $resolved | Should Be $null
        (Test-DevSpacePortOwnerStopAllowed `
            -ListenerProcessId 808 `
            -HealthyListener $false `
            -ResolvedProcess $resolved) | Should Be $false
    }

    It "does not authorize stopping a stale or PID-reused runtime record" {
        $runtimeState = [pscustomobject]@{
            devspacePid = 404
            devspaceCliPath = $expectedCli
            devspaceProcessStartIdentity = $startedAt.ToString('o')
        }
        $reusedProcess = [pscustomobject]@{
            ProcessId = 404
            CommandLine = "`"D:\nodejs\node.exe`" `"$expectedCli`" serve"
            CreationDate = $startedAt.AddHours(1)
        }

        $verifiedPid = Get-VerifiedDevSpaceStopProcessId `
            -RuntimeState $runtimeState `
            -CurrentProcess $reusedProcess
        $stopped = @()
        if ($null -ne $verifiedPid) { $stopped += $verifiedPid }

        $stopped.Count | Should Be 0
    }

    It "refuses a duplicate launch when a healthy listener cannot be identified" {
        $unresolved = Select-DevSpaceServeProcess `
            -Processes @([pscustomobject]@{ ProcessId = 505; CommandLine = $null; CreationDate = $startedAt }) `
            -ExpectedCliPath $expectedCli `
            -ListenerProcessId 505 `
            -HealthVerified $true

        { Assert-DevSpaceLaunchCanProceed -HealthyListener $true -ResolvedProcess $unresolved -ListenerProcessId 505 } | Should Throw
    }

    It "persists the listener PID instead of a launcher or stale fallback handle" {
        $actualCli = "E:\Code\devspace\devspace-src\.worktrees\devspace-listener\dist\cli.js"
        $processes = @(
            [pscustomobject]@{
                ProcessId = 600
                CommandLine = "`"D:\nodejs\node.exe`" `"$expectedCli`" serve"
                CreationDate = $startedAt
            },
            [pscustomobject]@{
                ProcessId = 601
                CommandLine = "`"D:\nodejs\node.exe`" `"$actualCli`" serve"
                CreationDate = $startedAt.AddSeconds(2)
            }
        )
        $resolved = Select-DevSpaceServeProcess `
            -Processes $processes `
            -ExpectedCliPath $expectedCli `
            -ListenerProcessId 601 `
            -HealthVerified $true
        $record = New-DevSpaceRuntimeProcessRecord -ResolvedProcess $resolved

        $record.devspacePid | Should Be 601
        $record.devspacePid | Should Not Be 600
        $record.devspaceCliPath | Should Be $actualCli
        $record.devspaceProcessStartIdentity | Should Be $startedAt.AddSeconds(2).ToString('o')
    }

    It "recognizes exact worktree CLI paths" {
        $commandLine = '"D:\nodejs\node.exe" "E:/Code/devspace/devspace-src/.worktrees/devspace-native/dist/cli.js" serve'

        (Test-DevSpaceServeCommandLine -CommandLine $commandLine -ExpectedCliPath $expectedCli) | Should Be $true
        (Get-DevSpaceCliPathFromCommandLine $commandLine) | Should Be $expectedCli
    }
}
