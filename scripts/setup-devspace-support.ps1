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

function Test-IsDevSpaceServeCommandLine {
    param([AllowNull()][string]$CommandLine)

    if ([string]::IsNullOrWhiteSpace($CommandLine)) {
        return $false
    }

    # Match main checkout and git worktrees under devspace-src:
    #   ...\devspace-src\dist\cli.js serve
    #   ...\devspace-src\.worktrees\<id>\dist\cli.js serve
    # Do not require dist to be an immediate child of devspace-src (worktree gap).
    $cliPathMatch = $CommandLine -match 'devspace-src(?:[\\/]+\.worktrees[\\/]+[^\\/"'']+)?[\\/]+dist[\\/]+cli\.js'
    if (-not $cliPathMatch) {
        # Broader fallback: any path segment .../dist/cli.js under a devspace-src tree
        # (covers deeper nesting while still requiring the repo folder name).
        $cliPathMatch = $CommandLine -match 'devspace-src[\\/].*[\\/]dist[\\/]cli\.js'
    }
    if (-not $cliPathMatch) {
        return $false
    }

    # Require serve as its own argv token, not a path substring.
    return [bool]($CommandLine -match '(?i)(?:^|[\s"''])serve(?:[\s"'']|$)')
}

