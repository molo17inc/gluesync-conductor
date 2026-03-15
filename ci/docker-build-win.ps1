#!/usr/bin/env pwsh

# --- Arguments ---
param (
  [Parameter(Mandatory = $true)]
  [string]$AppName,

  [Parameter(Mandatory = $true)]
  [string]$WindowsTag,

  [Parameter(Mandatory = $true)]
  [string]$WindowsVersion,

  [Parameter(Mandatory = $true)]
  [string]$WindowsYear,

  [string]$CustomDockerFile
)

# --- Fail immediately on any error ---
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ftpSite = $env:FTP_SITE
$ftpUser = $env:FTP_USER
$ftpPassword = $env:FTP_PASSWORD

function Convert-ToSafeSegment {
    param([string] $Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return ""
    }

    $lower = $Value.ToLowerInvariant()
    return ($lower -replace '[^a-z0-9._-]', '_')
}

function Get-FtpReleaseDirectories {
    param(
        [Parameter(Mandatory = $true)][string] $ReleaseType
    )

    switch ($ReleaseType.ToUpper()) {
        "GA" { return @("ga") }
        "BETA" { return @("beta") }
        "ALPHA" { return @("alpha", "internal") }
        "INTERNAL_TEST" { return @("internal") }
        default { throw "Unsupported release type '$ReleaseType' for FTP upload." }
    }
}

function Test-FtpDirectoryExistsError {
    param(
        [Parameter(Mandatory = $true)] $Exception
    )

    $ftpResponse = $null
    $statusDescription = $null
    $statusCode = $null

    if ($Exception.PSObject.Properties.Name -contains 'Response') {
        $ftpResponse = $Exception.Response
    }

    if ($ftpResponse -and $ftpResponse -is [System.Net.FtpWebResponse]) {
        $statusCode = $ftpResponse.StatusCode
        $statusDescription = $ftpResponse.StatusDescription
        $ftpResponse.Close()
    }

    if ($statusCode -eq [System.Net.FtpStatusCode]::ActionNotTakenFileUnavailable) {
        return $true
    }

    if ($statusDescription -and $statusDescription -match "550") {
        return $true
    }

    if ($Exception.Message -and $Exception.Message -match "550") {
        return $true
    }

    return $false
}

function Compress-FileToGzip {
    param(
        [Parameter(Mandatory = $true)][string] $InputPath,
        [Parameter(Mandatory = $true)][string] $OutputPath
    )

    $inputStream = $null
    $outputStream = $null
    $gzipStream = $null

    try {
        if (Test-Path $OutputPath) {
            Remove-Item -Path $OutputPath -Force
        }

        $inputStream = [System.IO.File]::OpenRead($InputPath)
        $outputStream = [System.IO.File]::Create($OutputPath)
        $gzipStream = New-Object System.IO.Compression.GzipStream($outputStream, [System.IO.Compression.CompressionLevel]::Optimal)
        $inputStream.CopyTo($gzipStream)
    }
    finally {
        if ($gzipStream) { $gzipStream.Dispose() }
        if ($outputStream) { $outputStream.Dispose() }
        if ($inputStream) { $inputStream.Dispose() }
    }
}

function Ensure-FtpDirectory {
    param(
        [Parameter(Mandatory = $true)][string] $RemoteDir,
        [Parameter(Mandatory = $true)][string] $Username,
        [Parameter(Mandatory = $true)][string] $Password
    )

    if ([string]::IsNullOrWhiteSpace($RemoteDir)) {
        return
    }

    $uri = [System.Uri]$RemoteDir
    $baseUri = "{0}://{1}" -f $uri.Scheme, $uri.Authority
    $segments = $uri.AbsolutePath.Trim('/').Split('/', [System.StringSplitOptions]::RemoveEmptyEntries)

    if ($segments.Count -eq 0) {
        return
    }

    $currentPath = ""
    foreach ($segment in $segments) {
        if ([string]::IsNullOrWhiteSpace($segment)) { continue }
        $currentPath = "$currentPath/$segment"
        $currentUri = "$baseUri$currentPath"

        try {
            $request = [System.Net.FtpWebRequest]::Create($currentUri)
            $request.Method = [System.Net.WebRequestMethods+Ftp]::MakeDirectory
            $request.Credentials = New-Object System.Net.NetworkCredential($Username, $Password)
            $request.UsePassive = $true
            $request.KeepAlive = $false
            $response = $request.GetResponse()
            $response.Close()
            Write-Host "Ensured FTP directory exists: ${currentUri}"
        }
        catch {
            $exception = $_.Exception
            if (Test-FtpDirectoryExistsError -Exception $exception) {
                Write-Host "FTP directory already exists: ${currentUri}"
                continue
            }

            throw "Failed to ensure FTP directory ${currentUri}: $exception"
        }
    }
}

function Upload-FtpFile {
    param(
        [Parameter(Mandatory = $true)][string] $LocalPath,
        [Parameter(Mandatory = $true)][string] $RemoteUri,
        [Parameter(Mandatory = $true)][string] $Username,
        [Parameter(Mandatory = $true)][string] $Password
    )

    if (-not (Test-Path $LocalPath)) {
        throw "Local file '$LocalPath' not found."
    }

    $localFileName = [System.IO.Path]::GetFileName($LocalPath)
    Write-Host "Starting FTP upload of $localFileName to $RemoteUri"
    $ftpRequest = [System.Net.FtpWebRequest]::Create($RemoteUri)
    $ftpRequest.Method = [System.Net.WebRequestMethods+Ftp]::UploadFile
    $ftpRequest.Credentials = New-Object System.Net.NetworkCredential($Username, $Password)
    $ftpRequest.UseBinary = $true
    $ftpRequest.UsePassive = $true
    $ftpRequest.KeepAlive = $false

    $fileContent = [System.IO.File]::ReadAllBytes($LocalPath)
    $ftpRequest.ContentLength = $fileContent.Length

    $requestStream = $null
    $response = $null

    try {
        $requestStream = $ftpRequest.GetRequestStream()
        $requestStream.Write($fileContent, 0, $fileContent.Length)
        $requestStream.Flush()
        $requestStream.Dispose()
        $requestStream = $null

        $response = $ftpRequest.GetResponse()
        $statusDescription = $response.StatusDescription

        try {
            $response.Close()
        }
        catch {
            Write-Warning "FTP server closed connection early: $_"
        }

        Write-Host "FTP upload completed ($statusDescription)"
    }
    catch {
        throw "FTP upload failed: $_"
    }
    finally {
        if ($requestStream) { $requestStream.Dispose() }
        if ($response) { $response.Dispose() }
    }
}

if ([string]::IsNullOrWhiteSpace($ftpSite) -or [string]::IsNullOrWhiteSpace($ftpUser) -or [string]::IsNullOrWhiteSpace($ftpPassword)) {
  throw "FTP credentials (FTP_SITE, FTP_USER, FTP_PASSWORD) must be set"
}

$CI_COMMIT_TAG = $env:CI_COMMIT_TAG
$CI_COMMIT_BRANCH = $env:CI_COMMIT_BRANCH
$CI_COMMIT_SHORT_SHA = $env:CI_COMMIT_SHORT_SHA

# --- Default values ---
$IMAGE_NAME = "molo17/$AppName"
$DEFAULT_DOCKER_FILE = "Dockerfile.windows"

$DOCKER_FILE = $DEFAULT_DOCKER_FILE

if ($CustomDockerFile) {
  $DOCKER_FILE = $CustomDockerFile
}

# --- Verify Dockerfile exists ---
if (-not (Test-Path -Path $DOCKER_FILE)) {
  throw "❌ Dockerfile not found: $DOCKER_FILE"
}
else {
  Write-Host "✅ Dockerfile found: $DOCKER_FILE"
}

# --- Extract version from tag or branch ---
if ($CI_COMMIT_TAG) {
  if ($CI_COMMIT_TAG -notmatch "^(alpha-|beta-|release-)") {
    throw "❌ Tag not valid: $CI_COMMIT_TAG. Must start with 'alpha-', 'beta-' or 'release-'."
    exit 1
  }

  Write-Host "Processing tag: $CI_COMMIT_TAG"
  $TAG_PART = [regex]::Match($CI_COMMIT_TAG, '[0-9]+\.[0-9]+\.[0-9](.*)').Value
  if (-not $TAG_PART) { throw "❌ Could not extract version from tag" }
}
else {
  Write-Host "No CI_COMMIT_TAG found, checking branch: $CI_COMMIT_BRANCH"

  $allowedBranches = @("develop")

  if ($allowedBranches -contains $CI_COMMIT_BRANCH) {
    $TAG_PART = $CI_COMMIT_BRANCH
    $releaseType = "INTERNAL_TEST"
    Write-Host "Branch '$TAG_PART' is allowed. Using as version part."
  }
  else {
    throw "❌ Branch '$CI_COMMIT_BRANCH' is not allowed and no tag found. Cannot determine version."
  }
}

Write-Host "Detected TAG_PART: $TAG_PART"
$VERSION = "$TAG_PART"
Write-Host "Default VERSION: $VERSION"

if ($CI_COMMIT_TAG -match '^alpha-') {
  $TAG_PART = "$TAG_PART.$CI_COMMIT_SHORT_SHA"
  $VERSION = "$TAG_PART.$CI_COMMIT_SHORT_SHA"
  $releaseType = "ALPHA"
  Write-Host "Alpha release detected, proceeding with TAG_PART: $TAG_PART and VERSION: $VERSION"
}
elseif ($CI_COMMIT_TAG -match '^beta-') {
  Write-Host "Beta release detected, proceeding with TAG_PART: $TAG_PART"
  $releaseType = "BETA"
}
elseif ($CI_COMMIT_TAG -match '^release-') {
  Write-Host "GA release detected, proceeding with TAG_PART: $TAG_PART"
  $releaseType = "GA"
}

$releaseType ??= "INTERNAL_TEST"
Write-Host "Release type: $releaseType"

$safeImageName = Convert-ToSafeSegment $AppName
$safeReleaseTag = Convert-ToSafeSegment $releaseType

$VERSION_TAG_WINDOWS = "${IMAGE_NAME}:${TAG_PART}-win-${WindowsVersion}-${WindowsTag}"
Write-Host "Image name: $IMAGE_NAME"
Write-Host "Version tag: $VERSION_TAG_WINDOWS"

# --- Create VERSION file ---
Set-Content -Path "VERSION" -Value $TAG_PART
Write-Host "✅ VERSION file created with content: $(Get-Content VERSION)"

# --- Docker login ---
Write-Host "Logging into Docker registry..."
$env:CI_REGISTRY_PASSWORD | docker login -u $env:CI_REGISTRY_USER --password-stdin
if ($LASTEXITCODE -ne 0) { throw "❌ Docker login failed" }
Write-Host "✅ Docker login successful"

# --- Build Windows Docker image ---
Write-Host "Building Docker image for $($WindowsTag) using default Server Core..."
docker build --file ${DOCKER_FILE} `
  --build-arg WINDOWS_TAG="$($WindowsTag)" `
  --build-arg WINDOWS_VERSION="$($WindowsVersion)" `
  --build-arg WINDOWS_YEAR="$($WindowsYear)" `
  --tag "$VERSION_TAG_WINDOWS" .

if ($LASTEXITCODE -ne 0) { throw "❌ Docker build failed" }
Write-Host "✅ Docker build completed successfully for $($WindowsTag)"

$tarDirectory = Join-Path (Get-Location) "docker-images-windows"
New-Item -ItemType Directory -Force -Path $tarDirectory | Out-Null
$tarBaseName = "gluesync-conductor-${WindowsVersion}-${WindowsTag}"
$tarFilePath = Join-Path $tarDirectory "$tarBaseName.tar"

Write-Host "Saving Docker image to $tarFilePath"
docker save "$VERSION_TAG_WINDOWS" -o $tarFilePath
if ($LASTEXITCODE -ne 0) { throw "❌ Failed to save Docker image" }

$gzFilePath = "$tarFilePath.gz"
Write-Host "Compressing Docker image tar to $gzFilePath"
Compress-FileToGzip -InputPath $tarFilePath -OutputPath $gzFilePath
Remove-Item -Path $tarFilePath -Force

$releaseDirectories = Get-FtpReleaseDirectories -ReleaseType $releaseType
$remoteFileName = "$safeImageName-$safeReleaseTag.tar.gz"

foreach ($dir in $releaseDirectories) {
    $normalizedDir = $dir.Trim('/')
    if ([string]::IsNullOrWhiteSpace($normalizedDir)) { continue }

    $remoteDirPath = "/releases/$normalizedDir/windows"
    $remoteDirUri = "ftp://$ftpSite$remoteDirPath"
    Ensure-FtpDirectory -RemoteDir $remoteDirUri -Username $ftpUser -Password $ftpPassword

    $remoteUri = "$remoteDirUri/$remoteFileName"
    Upload-FtpFile -LocalPath $gzFilePath -RemoteUri $remoteUri -Username $ftpUser -Password $ftpPassword
}

Remove-Item -Path $gzFilePath -Force -ErrorAction SilentlyContinue

# --- Push Windows Docker image ---
docker push "$VERSION_TAG_WINDOWS"
if ($LASTEXITCODE -ne 0) { throw "❌ Docker push failed" }
Write-Host "✅ Pushed $VERSION_TAG_WINDOWS"

# --- Tag and push latest-windows for release branches ---
if ($CI_COMMIT_TAG -match '^release-') {
  $LATEST_BASE = "${IMAGE_NAME}:latest"
  $LATEST_TAG = "${LATEST_BASE}-win-${WindowsVersion}-${WindowsTag}"

  Write-Host "Tagging $VERSION_TAG_WINDOWS as $LATEST_TAG"
  docker tag "$VERSION_TAG_WINDOWS" "$LATEST_TAG"
  if ($LASTEXITCODE -ne 0) { throw "❌ Docker tag failed" }

  docker push "$LATEST_TAG"
  if ($LASTEXITCODE -ne 0) { throw "❌ Docker push latest-windows failed" }

  Write-Host "✅ Pushed $LATEST_TAG"

  # --- Backwards compatibility for ltsc2022 ---
  if ($WindowsTag -eq "ltsc2022") {
    $LEGACY_TAG = "${LATEST_BASE}-windows"

    Write-Host "Tagging $VERSION_TAG_WINDOWS as $LEGACY_TAG"
    docker tag "$VERSION_TAG_WINDOWS" "$LEGACY_TAG"
    if ($LASTEXITCODE -ne 0) { throw "❌ Docker tag legacy failed" }

    docker push "$LEGACY_TAG"
    if ($LASTEXITCODE -ne 0) { throw "❌ Docker push legacy failed" }

    Write-Host "✅ Pushed legacy tag $LEGACY_TAG (for ltsc2022)"
  }
}
