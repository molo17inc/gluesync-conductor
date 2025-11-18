#!/usr/bin/env pwsh

# --- Fail immediately on any error ---
$ErrorActionPreference = "Stop"

# --- Arguments ---
param (
  [Parameter(Mandatory = $true)]
  [string]$AppName,

  [Parameter(Mandatory = $true)]
  [string]$WindowsTag,

  [Parameter(Mandatory = $true)]
  [string]$WindowsVersion,

  [string]$CustomDockerFile
)

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
if ($env:CI_COMMIT_TAG) {
  Write-Host "Processing tag: $env:CI_COMMIT_TAG"
  $TAG_PART = [regex]::Match($env:CI_COMMIT_TAG, '[0-9]+\.[0-9]+\.[0-9](.*)').Value
  if (-not $TAG_PART) { throw "❌ Could not extract version from tag" }
}
else {
  Write-Host "No CI_COMMIT_TAG found, checking branch: $env:CI_COMMIT_BRANCH"

  $allowedBranches = @("develop")

  if ($allowedBranches -contains $env:CI_COMMIT_BRANCH) {
    $TAG_PART = $env:CI_COMMIT_BRANCH
    Write-Host "Branch '$TAG_PART' is allowed. Using as version part."
  }
  else {
    throw "❌ Branch '$env:CI_COMMIT_BRANCH' is not allowed and no tag found. Cannot determine version."
  }
}

Write-Host "Using TAG_PART: $TAG_PART"
$VERSION_TAG_WINDOWS = "${IMAGE_NAME}:${TAG_PART}-win-${WindowsVersion}-${WindowsTag}"
Write-Host "Image name: $IMAGE_NAME"
Write-Host "Version tag: $VERSION_TAG_WINDOWS"

# --- Create VERSION file ---
Set-Content -Path "VERSION" -Value $TAG_PART
Write-Host "✅ VERSION file created with content: $(Get-Content VERSION)"

# --- Docker login ---
Write-Host "Logging into Docker registry..."
$CI_REGISTRY_PASSWORD | docker login -u $env:CI_REGISTRY_USER --password-stdin
if ($LASTEXITCODE -ne 0) { throw "❌ Docker login failed" }
Write-Host "✅ Docker login successful"

# --- Build Windows Docker image (conditional on WindowsTag) ---
# if ($WindowsTag -eq "ltsc2019") {
#   Write-Host "Building Docker image for LTSC2019..."
#   docker build --file Dockerfile.windows.nanoserver.2019 `
#     --build-arg WINDOWS_TAG="$($WindowsTag)" `
#     --build-arg WINDOWS_VERSION="$($WindowsVersion)" `
#     --tag "$VERSION_TAG_WINDOWS" .
# }
# else {
#   Write-Host "Building Docker image for $($WindowsTag) using default Server Core..."
#   docker build --file ${DOCKER_FILE} `
#     --build-arg WINDOWS_TAG="$($WindowsTag)" `
#     --build-arg WINDOWS_VERSION="$($WindowsVersion)" `
#     --tag "$VERSION_TAG_WINDOWS" .
# }

Write-Host "Building Docker image for $($WindowsTag) using default Server Core..."
docker build --file ${DOCKER_FILE} `
  --build-arg WINDOWS_TAG="$($WindowsTag)" `
  --build-arg WINDOWS_VERSION="$($WindowsVersion)" `
  --tag "$VERSION_TAG_WINDOWS" .

if ($LASTEXITCODE -ne 0) { throw "❌ Docker build failed" }
Write-Host "✅ Docker build completed successfully for $($WindowsTag)"

# --- Push Windows Docker image ---
docker push "$VERSION_TAG_WINDOWS"
if ($LASTEXITCODE -ne 0) { throw "❌ Docker push failed" }
Write-Host "✅ Pushed $VERSION_TAG_WINDOWS"

# # --- Tag and push latest-windows for release branches ---
# if ($env:CI_COMMIT_TAG -match '^release-') {
#   $LATEST_BASE = "$IMAGE_NAME:latest"
#   $LATEST_TAG = "$LATEST_BASE-win-$($WindowsVersion)-$($WindowsTag)"

#   docker tag "$VERSION_TAG_WINDOWS" "$LATEST_TAG"
#   if ($LASTEXITCODE -ne 0) { throw "❌ Docker tag failed" }

#   docker push "$LATEST_TAG"
#   if ($LASTEXITCODE -ne 0) { throw "❌ Docker push latest-windows failed" }

#   Write-Host "✅ Pushed $LATEST_TAG"

#   # --- Backwards compatibility for ltsc2022 ---
#   if ($WindowsTag -eq "ltsc2022") {
#     $LEGACY_TAG = "$LATEST_BASE-windows"
#     docker tag "$VERSION_TAG_WINDOWS" "$LEGACY_TAG"
#     if ($LASTEXITCODE -ne 0) { throw "❌ Docker tag legacy failed" }

#     docker push "$LEGACY_TAG"
#     if ($LASTEXITCODE -ne 0) { throw "❌ Docker push legacy failed" }

#     Write-Host "✅ Pushed legacy tag $LEGACY_TAG (for ltsc2022)"
#   }
# }
