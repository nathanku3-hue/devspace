function Get-PersistedDevSpaceProbeClient {
    param(
        [Parameter(Mandatory = $true)][string]$ClientFile,
        [Parameter(Mandatory = $true)][string]$LocalBaseUrl,
        [Parameter(Mandatory = $true)][string]$RedirectUri
    )

    if (-not (Test-Path -LiteralPath $ClientFile -PathType Leaf)) {
        return $null
    }

    try {
        $record = Get-Content -LiteralPath $ClientFile -Raw | ConvertFrom-Json
        $metadataMatches = (
            [int]$record.schemaVersion -eq 1 -and
            [System.StringComparer]::Ordinal.Equals([string]$record.localBaseUrl, $LocalBaseUrl) -and
            [System.StringComparer]::Ordinal.Equals([string]$record.redirectUri, $RedirectUri)
        )
        if (
            -not $metadataMatches -or
            [string]::IsNullOrWhiteSpace([string]$record.client_id) -or
            [string]::IsNullOrWhiteSpace([string]$record.client_secret)
        ) {
            return $null
        }
        return [pscustomobject]@{
            client_id     = [string]$record.client_id
            client_secret = [string]$record.client_secret
        }
    } catch {
        return $null
    }
}

function Save-PersistedDevSpaceProbeClient {
    param(
        [Parameter(Mandatory = $true)][string]$ClientFile,
        [Parameter(Mandatory = $true)][string]$LocalBaseUrl,
        [Parameter(Mandatory = $true)][string]$RedirectUri,
        [Parameter(Mandatory = $true)]$Client
    )

    if (
        [string]::IsNullOrWhiteSpace([string]$Client.client_id) -or
        [string]::IsNullOrWhiteSpace([string]$Client.client_secret)
    ) {
        throw "Cannot persist DevSpace setup probe client without client_id and client_secret."
    }

    $directory = Split-Path -Parent $ClientFile
    if (-not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }

    $record = [ordered]@{
        schemaVersion = 1
        localBaseUrl  = $LocalBaseUrl
        redirectUri   = $RedirectUri
        client_id     = [string]$Client.client_id
        client_secret = [string]$Client.client_secret
        savedAt       = (Get-Date).ToString("o")
    }
    $temporaryFile = "$ClientFile.tmp-$PID-$([Guid]::NewGuid().ToString('N'))"
    try {
        ($record | ConvertTo-Json -Depth 4) | Set-Content -LiteralPath $temporaryFile -Encoding UTF8
        Move-Item -LiteralPath $temporaryFile -Destination $ClientFile -Force
    } finally {
        Remove-Item -LiteralPath $temporaryFile -Force -ErrorAction SilentlyContinue
    }
}

function Resolve-DevSpaceProbeClient {
    param(
        [Parameter(Mandatory = $true)][string]$ClientFile,
        [Parameter(Mandatory = $true)][string]$LocalBaseUrl,
        [Parameter(Mandatory = $true)][string]$RedirectUri,
        [Parameter(Mandatory = $true)][scriptblock]$RegistrationAction
    )

    $persisted = Get-PersistedDevSpaceProbeClient `
        -ClientFile $ClientFile `
        -LocalBaseUrl $LocalBaseUrl `
        -RedirectUri $RedirectUri
    if ($null -ne $persisted) {
        return [pscustomobject]@{ Client = $persisted; Reused = $true }
    }

    $registered = & $RegistrationAction $LocalBaseUrl $RedirectUri
    Save-PersistedDevSpaceProbeClient `
        -ClientFile $ClientFile `
        -LocalBaseUrl $LocalBaseUrl `
        -RedirectUri $RedirectUri `
        -Client $registered
    return [pscustomobject]@{ Client = $registered; Reused = $false }
}

function Assert-ExpectedToolInventory {
    param(
        [Parameter(Mandatory = $true)][string]$EndpointLabel,
        [Parameter(Mandatory = $true)][string[]]$ExpectedTools,
        [Parameter(Mandatory = $true)][string[]]$ActualTools
    )

    $ordinal = [System.StringComparer]::Ordinal
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ($ordinal)
    foreach ($tool in $ActualTools) {
        if (-not $seen.Add([string]$tool)) {
            throw "${EndpointLabel} tool inventory contains duplicate ordinal name '$tool'."
        }
    }

    $expected = @($ExpectedTools | Sort-Object -CaseSensitive)
    $actual = @($ActualTools | Sort-Object -CaseSensitive)
    if ($actual.Count -ne $expected.Count) {
        throw "${EndpointLabel} tool inventory mismatch. Expected: $($expected -join ', '). Actual: $($actual -join ', ')."
    }

    for ($index = 0; $index -lt $expected.Count; $index++) {
        if (-not $ordinal.Equals([string]$expected[$index], [string]$actual[$index])) {
            throw "${EndpointLabel} tool inventory mismatch. Expected: $($expected -join ', '). Actual: $($actual -join ', ')."
        }
    }

    return $actual
}

function ConvertTo-NormalizedDevSpacePath {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return ""
    }
    return $Path.Trim().Trim('"').Replace('/', '\').TrimEnd('\')
}

function Get-DevSpaceProcessId {
    param($Process)

    if ($null -eq $Process) {
        return 0
    }
    if ($null -ne $Process.PSObject.Properties['ProcessId']) {
        return [int]$Process.ProcessId
    }
    if ($null -ne $Process.PSObject.Properties['Id']) {
        return [int]$Process.Id
    }
    return 0
}

function Get-DevSpaceProcessStartIdentity {
    param($Process)

    if ($null -eq $Process) {
        return ""
    }
    $value = $null
    if ($null -ne $Process.PSObject.Properties['CreationDate']) {
        $value = $Process.CreationDate
    } elseif ($null -ne $Process.PSObject.Properties['StartTime']) {
        $value = $Process.StartTime
    }
    if ($null -eq $value) {
        return ""
    }
    try {
        if ($value -is [DateTime]) {
            return ([DateTime]$value).ToUniversalTime().ToString('o')
        }
        return ([DateTimeOffset]::Parse([string]$value)).ToUniversalTime().ToString('o')
    } catch {
        return ([string]$value).Trim()
    }
}

function Test-DevSpaceServeCommandLine {
    param(
        [string]$CommandLine,
        [Parameter(Mandatory = $true)][string]$ExpectedCliPath
    )

    if ([string]::IsNullOrWhiteSpace($CommandLine)) {
        return $false
    }
    $normalizedCommand = $CommandLine.Replace('/', '\')
    $normalizedExpected = ConvertTo-NormalizedDevSpacePath $ExpectedCliPath
    if ([string]::IsNullOrWhiteSpace($normalizedExpected)) {
        return $false
    }
    if ($normalizedCommand -notmatch '(?i)(^|\s)serve(?=$|\s)') {
        return $false
    }
    $pathPattern = '(?i)(^|[\s"])' + [regex]::Escape($normalizedExpected) + '(?=$|[\s"])'
    return [regex]::IsMatch($normalizedCommand, $pathPattern)
}

function Get-DevSpaceCliPathFromCommandLine {
    param([string]$CommandLine)

    if ([string]::IsNullOrWhiteSpace($CommandLine)) {
        return ""
    }
    $normalized = $CommandLine.Replace('/', '\')
    if ($normalized -notmatch '(?i)(^|\s)serve(?=$|\s)') {
        return ""
    }
    $quoted = [regex]::Match($normalized, '(?i)"(?<path>[a-z]:\\[^"]*\\dist\\cli\.js)"')
    if ($quoted.Success) {
        return ConvertTo-NormalizedDevSpacePath $quoted.Groups['path'].Value
    }
    $unquoted = [regex]::Match($normalized, '(?i)(?<path>[a-z]:\\[^\s"]*\\dist\\cli\.js)(?=\s+serve(?:\s|$))')
    if ($unquoted.Success) {
        return ConvertTo-NormalizedDevSpacePath $unquoted.Groups['path'].Value
    }
    return ""
}

function New-ResolvedDevSpaceProcess {
    param(
        [Parameter(Mandatory = $true)]$Process,
        [Parameter(Mandatory = $true)][string]$CliPath,
        [Parameter(Mandatory = $true)][string]$Resolution
    )

    return [pscustomobject]@{
        ProcessId           = Get-DevSpaceProcessId $Process
        CommandLine         = [string]$Process.CommandLine
        CliPath             = ConvertTo-NormalizedDevSpacePath $CliPath
        ProcessStartIdentity = Get-DevSpaceProcessStartIdentity $Process
        Resolution          = $Resolution
    }
}

function Select-DevSpaceServeProcess {
    param(
        [object[]]$Processes = @(),
        [Parameter(Mandatory = $true)][string]$ExpectedCliPath,
        [int]$ListenerProcessId = 0,
        [bool]$HealthVerified = $false
    )

    $exactMatches = @($Processes | Where-Object {
        Test-DevSpaceServeCommandLine -CommandLine ([string]$_.CommandLine) -ExpectedCliPath $ExpectedCliPath
    })

    if ($ListenerProcessId -gt 0) {
        $exactListener = $exactMatches | Where-Object {
            (Get-DevSpaceProcessId $_) -eq $ListenerProcessId
        } | Select-Object -First 1
        if ($null -ne $exactListener) {
            return New-ResolvedDevSpaceProcess -Process $exactListener -CliPath $ExpectedCliPath -Resolution 'exact-cli-listener'
        }
    } elseif ($exactMatches.Count -gt 0) {
        $exact = $exactMatches | Sort-Object @{ Expression = { Get-DevSpaceProcessId $_ } } | Select-Object -First 1
        return New-ResolvedDevSpaceProcess -Process $exact -CliPath $ExpectedCliPath -Resolution 'exact-cli'
    }

    # CLI path on the port owner is sufficient identity for both healthy and hung
    # listeners. /healthz alone used to be required for this branch, which blocked
    # cleanup when DevSpace held the port but stopped answering HTTP.
    if ($ListenerProcessId -gt 0) {
        $owner = $Processes | Where-Object {
            (Get-DevSpaceProcessId $_) -eq $ListenerProcessId
        } | Select-Object -First 1
        if ($null -ne $owner) {
            $actualCliPath = Get-DevSpaceCliPathFromCommandLine ([string]$owner.CommandLine)
            if (-not [string]::IsNullOrWhiteSpace($actualCliPath)) {
                $resolution = if ($HealthVerified) {
                    'health-verified-port-owner'
                } else {
                    'cli-path-port-owner'
                }
                return New-ResolvedDevSpaceProcess -Process $owner -CliPath $actualCliPath -Resolution $resolution
            }
        }
    }

    return $null
}

function Test-DevSpacePortOwnerStopAllowed {
    param(
        [int]$ListenerProcessId = 0,
        [bool]$HealthyListener = $false,
        $ResolvedProcess = $null
    )

    if ($ListenerProcessId -le 0) {
        return $true
    }
    if ($HealthyListener) {
        return $true
    }
    return (
        $null -ne $ResolvedProcess -and
        [int]$ResolvedProcess.ProcessId -eq $ListenerProcessId
    )
}

function Assert-DevSpaceLaunchCanProceed {
    param(
        [bool]$HealthyListener,
        $ResolvedProcess,
        [int]$ListenerProcessId = 0
    )

    if ($HealthyListener -and $null -eq $ResolvedProcess) {
        throw "DevSpace is healthy on port 7676 (PID=$ListenerProcessId) but its exact process identity could not be verified. Refusing a second launch."
    }
}

function New-DevSpaceRuntimeProcessRecord {
    param([Parameter(Mandatory = $true)]$ResolvedProcess)

    if ([int]$ResolvedProcess.ProcessId -le 0) {
        throw "Cannot persist DevSpace runtime state without a listener PID."
    }
    if ([string]::IsNullOrWhiteSpace([string]$ResolvedProcess.CliPath)) {
        throw "Cannot persist DevSpace runtime state without a CLI path."
    }
    if ([string]::IsNullOrWhiteSpace([string]$ResolvedProcess.ProcessStartIdentity)) {
        throw "Cannot persist DevSpace runtime state without a process start identity."
    }
    return [ordered]@{
        devspacePid                    = [int]$ResolvedProcess.ProcessId
        devspaceCliPath                = ConvertTo-NormalizedDevSpacePath ([string]$ResolvedProcess.CliPath)
        devspaceProcessStartIdentity   = [string]$ResolvedProcess.ProcessStartIdentity
        devspaceProcessResolution      = [string]$ResolvedProcess.Resolution
    }
}

function Get-VerifiedDevSpaceStopProcessId {
    param(
        [Parameter(Mandatory = $true)]$RuntimeState,
        [Parameter(Mandatory = $true)]$CurrentProcess
    )

    $currentPid = Get-DevSpaceProcessId $CurrentProcess
    if ($currentPid -le 0 -or $currentPid -ne [int]$RuntimeState.devspacePid) {
        return $null
    }
    $persistedCliPath = ConvertTo-NormalizedDevSpacePath ([string]$RuntimeState.devspaceCliPath)
    $persistedStartIdentity = [string]$RuntimeState.devspaceProcessStartIdentity
    if (
        [string]::IsNullOrWhiteSpace($persistedCliPath) -or
        [string]::IsNullOrWhiteSpace($persistedStartIdentity)
    ) {
        return $null
    }
    if (-not (Test-DevSpaceServeCommandLine -CommandLine ([string]$CurrentProcess.CommandLine) -ExpectedCliPath $persistedCliPath)) {
        return $null
    }
    $currentStartIdentity = Get-DevSpaceProcessStartIdentity $CurrentProcess
    if (-not [System.StringComparer]::Ordinal.Equals($persistedStartIdentity, $currentStartIdentity)) {
        return $null
    }
    return $currentPid
}
