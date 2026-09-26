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

function Get-DevSpaceValidatedCachedToolInventory {
    param(
        [AllowNull()]$State,
        [Parameter(Mandatory = $true)][string[]]$ExpectedTools,
        [int]$ExpectedDevSpacePid = 0,
        [string]$ExpectedCliSha256 = "",
        [string]$ExpectedTunnelHost = "",
        [string]$ExpectedPublicBaseUrl = ""
    )

    if ($null -eq $State -or $null -eq $State.toolInventory) {
        return $null
    }
    if ($ExpectedDevSpacePid -gt 0 -and [int]$State.devspacePid -ne $ExpectedDevSpacePid) {
        return $null
    }
    if (
        -not [string]::IsNullOrWhiteSpace($ExpectedCliSha256) -and
        -not [System.StringComparer]::OrdinalIgnoreCase.Equals([string]$State.source.cliSha256, $ExpectedCliSha256)
    ) {
        return $null
    }
    if (
        -not [string]::IsNullOrWhiteSpace($ExpectedTunnelHost) -and
        -not [System.StringComparer]::OrdinalIgnoreCase.Equals([string]$State.tunnelHost, $ExpectedTunnelHost)
    ) {
        return $null
    }
    if (
        -not [string]::IsNullOrWhiteSpace($ExpectedPublicBaseUrl) -and
        -not [System.StringComparer]::OrdinalIgnoreCase.Equals(
            ([string]$State.publicBaseUrl).TrimEnd('/'),
            $ExpectedPublicBaseUrl.TrimEnd('/')
        )
    ) {
        return $null
    }

    try {
        $expected = Assert-ExpectedToolInventory -EndpointLabel "Cached expected" -ExpectedTools $ExpectedTools -ActualTools @($State.toolInventory.expected)
        $local = Assert-ExpectedToolInventory -EndpointLabel "Cached local" -ExpectedTools $ExpectedTools -ActualTools @($State.toolInventory.local)
        $public = Assert-ExpectedToolInventory -EndpointLabel "Cached public" -ExpectedTools $ExpectedTools -ActualTools @($State.toolInventory.public)
    } catch {
        return $null
    }

    return [pscustomobject]@{
        Expected = @($expected)
        Local    = @($local)
        Public   = @($public)
    }
}
