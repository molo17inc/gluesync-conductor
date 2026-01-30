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
  Write-Host "Alpha release detected, proceeding with TAG_PART: $TAG_PART and VERSION: $VERSION"
}
elseif ($CI_COMMIT_TAG -match '^beta-') {
  Write-Host "Beta release detected, proceeding with TAG_PART: $TAG_PART"
}
elseif ($CI_COMMIT_TAG -match '^release-') {
  Write-Host "GA release detected, proceeding with TAG_PART: $TAG_PART"
}

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
