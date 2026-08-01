$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$supportScript = Join-Path $here "setup-devspace-support.ps1"
. $supportScript

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
        "web_connector_probe",
        "web_connector_proof",
        "web_launch",
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
