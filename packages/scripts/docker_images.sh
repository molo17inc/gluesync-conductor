#!/bin/bash
set -e
set -o pipefail

# Usage:
# ./script.sh [--platform linux/amd64,linux/arm64] /path/to/context image_name tag1,tag2,tag3 [...]

# Default platform
PLATFORM="linux/amd64,linux/arm64"

FTP_BASE_DIR="/molo17.com/public_html/gs-content/releases"
FTP_TARGET_DIR=""
FTP_SAVE_PLATFORM="${FTP_SAVE_PLATFORM:-linux/amd64}"
FTP_UPLOAD_ENABLED=false

sanitize_segment() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9._-]/_/g'
}

if [ -n "${RELEASE_TYPE:-}" ]; then
  RELEASE_TYPE_LOWER=$(echo "$RELEASE_TYPE" | tr '[:upper:]' '[:lower:]')
  case "$RELEASE_TYPE_LOWER" in
    ga|beta|alpha|internal_test)
      FTP_TARGET_DIR="$FTP_BASE_DIR/$RELEASE_TYPE_LOWER"
      ;;
    *)
      echo "[WARN] Unrecognized RELEASE_TYPE: $RELEASE_TYPE. FTP upload disabled."
      ;;
  esac
else
  echo "[WARN] RELEASE_TYPE not set. FTP upload disabled."
fi

if [ -n "$FTP_TARGET_DIR" ]; then
  if [ -n "${FTP_SITE:-}" ] && [ -n "${FTP_USER:-}" ] && [ -n "${FTP_PASSWORD:-}" ]; then
    FTP_UPLOAD_ENABLED=true
  else
    echo "[WARN] FTP credentials missing. FTP upload disabled."
  fi
fi

upload_docker_tar() {
  local full_image="$1"
  local image_name="$2"
  local tag="$3"

  if [ "$FTP_UPLOAD_ENABLED" != true ]; then
    return 0
  fi

  local safe_image
  safe_image=$(sanitize_segment "$image_name")
  local safe_tag
  safe_tag=$(sanitize_segment "$tag")
  local tar_basename="${safe_image}-${safe_tag}.tar"
  local tar_path
  tar_path=$(mktemp "/tmp/${safe_image}-${safe_tag}.XXXXXX.tar")

  echo "Saving $full_image to $tar_path"
  docker save "$full_image" -o "$tar_path"

  local ftp_url="ftp://$FTP_SITE${FTP_TARGET_DIR}/$tar_basename"
  echo "Uploading $(basename "$tar_path") to $ftp_url"
  curl -T "$tar_path" --user "$FTP_USER:$FTP_PASSWORD" "$ftp_url"

  rm -f "$tar_path"
}

# Check if first parameter is --platform
if [[ "$1" == "--platform" ]]; then
  PLATFORM="$2"
  shift 2
fi

if [ "$#" -lt 3 ]; then
  echo "Usage: $0 [--platform linux/amd64,linux/arm64] /path/to/context image_name tag1,tag2,tag3 [/another/path image_name tagX,tagY ...]"
  exit 1
fi

pids=()
errors=()

while [ "$#" -gt 0 ]; do
  CONTEXT="$1"
  IMAGE_NAME="$2"
  TAGS_RAW="$3"
  shift 3

  # Split comma-separated tags into array
  IFS=',' read -ra TAGS <<< "$TAGS_RAW"

  (
    cd "$CONTEXT" || { echo "Failed to enter $CONTEXT"; exit 1; }
    echo "Building image $IMAGE_NAME from context: $CONTEXT"
    echo "Platform: $PLATFORM"
    echo "Tags: ${TAGS[*]}"

    # Build docker buildx command with multiple tags
    DOCKER_CMD="docker buildx build --platform $PLATFORM --progress=plain --no-cache"
    for TAG in "${TAGS[@]}"; do
      FULL_IMAGE="$CI_REGISTRY_IMAGE/$IMAGE_NAME:$TAG"
      DOCKER_CMD="$DOCKER_CMD -t $FULL_IMAGE"
      echo " -> Tagging as $FULL_IMAGE"
    done

    # Retry up to 3 times in case of error
    attempt=0
    until [ $attempt -ge 3 ]; do
      eval "$DOCKER_CMD --push ." && break

      attempt=$((attempt+1))
      echo "Retry $attempt for $IMAGE_NAME with tags ${TAGS[*]}..."
      sleep 10
    done

    if [ $attempt -ge 3 ]; then
      echo "Build failed for $IMAGE_NAME with tags ${TAGS[*]} after 3 attempts"
      exit 1
    fi
  ) &

  pids+=($!)
done

# Wait for all parallel jobs
for pid in "${pids[@]}"; do
  wait $pid || errors+=($pid)
done

if [ "${#errors[@]}" -ne 0 ]; then
  echo "Some builds failed: ${errors[*]}"
  exit 1
fi

echo "All builds finished successfully."
