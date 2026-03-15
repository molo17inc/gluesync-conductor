#!/bin/bash
set -e
set -o pipefail

# Usage:
# ./script.sh [--platform linux/amd64,linux/arm64] /path/to/context image_name tag1,tag2,tag3 [...]

# Default platform
PLATFORM="linux/amd64,linux/arm64"

FTP_BASE_DIR="/releases/linux"
FTP_TARGET_DIRS=()
FTP_UPLOAD_ENABLED=false

sanitize_segment() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9._-]/_/g'
}

map_release_dirs() {
  local type_upper
  type_upper=$(echo "$1" | tr '[:lower:]' '[:upper:]')
  case "$type_upper" in
    GA)
      printf '%s\n' "ga"
      ;;
    BETA)
      printf '%s\n' "beta"
      ;;
    ALPHA)
      printf '%s\n' "alpha" "internal"
      ;;
    INTERNAL_TEST)
      printf '%s\n' "internal"
      ;;
    *) return 1 ;;
  esac
}

if [ -n "${RELEASE_TYPE:-}" ]; then
  if map_release_dirs "$RELEASE_TYPE" >/tmp/ftp_dirs.$$; then
    while IFS= read -r dir; do
      FTP_TARGET_DIRS+=("$FTP_BASE_DIR/$dir")
    done </tmp/ftp_dirs.$$
    rm -f /tmp/ftp_dirs.$$ >/dev/null 2>&1 || true
  else
    echo "[WARN] Unrecognized RELEASE_TYPE: $RELEASE_TYPE. FTP upload disabled."
  fi
else
  echo "[WARN] RELEASE_TYPE not set. FTP upload disabled."
fi

if [ ${#FTP_TARGET_DIRS[@]} -gt 0 ]; then
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

  if [ ${#FTP_TARGET_DIRS[@]} -eq 0 ]; then
    echo "[WARN] No FTP target directories resolved; skipping upload"
    return 0
  fi

  local safe_image
  safe_image=$(sanitize_segment "$image_name")
  local safe_release
  safe_release=$(sanitize_segment "${RELEASE_TYPE:-unknown}")
  local safe_tag
  safe_tag=$(sanitize_segment "$tag")
  local tmp_base
  tmp_base=$(mktemp "/tmp/${safe_image}-${safe_tag}.XXXXXX")
  local tar_path="${tmp_base}.tar"
  local gz_path="${tar_path}.gz"
  rm -f "$tmp_base"
  local remote_basename="${safe_image}-${safe_release}.tar.gz"

  echo "Pulling $full_image before save"
  docker pull "$full_image"

  echo "Saving $full_image to $tar_path"
  docker save "$full_image" -o "$tar_path"

  echo "Compressing tar to $gz_path"
  if ! gzip -c "$tar_path" > "$gz_path"; then
    rm -f "$tar_path" "$gz_path"
    echo "[ERROR] Failed to gzip $tar_path"
    return 1
  fi
  rm -f "$tar_path"

  for target_dir in "${FTP_TARGET_DIRS[@]}"; do
    local ftp_url="ftp://$FTP_SITE${target_dir}/$remote_basename"
    echo "Uploading $(basename "$gz_path") to $ftp_url"
    curl --ftp-create-dirs -T "$gz_path" --user "$FTP_USER:$FTP_PASSWORD" "$ftp_url"
  done

  rm -f "$gz_path"
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
      if eval "$DOCKER_CMD --push ."; then
        build_success=true
        break
      fi

      build_success=false
      attempt=$((attempt+1))
      echo "Retry $attempt for $IMAGE_NAME with tags ${TAGS[*]}..."
      sleep 10
    done

    if [ "$build_success" != true ]; then
      echo "Build failed for $IMAGE_NAME with tags ${TAGS[*]} after 3 attempts"
      exit 1
    fi

    for TAG in "${TAGS[@]}"; do
      FULL_IMAGE="$CI_REGISTRY_IMAGE/$IMAGE_NAME:$TAG"
      upload_docker_tar "$FULL_IMAGE" "$IMAGE_NAME" "$TAG"
    done
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
