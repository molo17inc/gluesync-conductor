#!/bin/bash
set -e
set -o pipefail

# Check if at least two arguments are provided (path + image:tag)
if [ "$#" -lt 2 ] || [ $(( $# % 2 )) -ne 0 ]; then
  echo "Usage: $0 /path/to/context image_name:tag [/another/path another_image:tag ...]"
  exit 1
fi

pids=()
errors=()

while [ "$#" -gt 0 ]; do
  CONTEXT="$1"
  IMAGE_NAME="$2"
  shift 2

  (
    cd "$CONTEXT" || { echo "Failed to enter $CONTEXT"; exit 1; }
    FULL_IMAGE="$CI_REGISTRY_IMAGE/$IMAGE_NAME"
    echo "Building $FULL_IMAGE from context: $CONTEXT"

    # Retry up to 3 times in case of error
    attempt=0
    until [ $attempt -ge 3 ]; do
      docker buildx build \
        --platform linux/amd64,linux/arm64 \
        --progress=plain \
        --no-cache \
        -t "$FULL_IMAGE" \
        --push . && break

      attempt=$((attempt+1))
      echo "Retry $attempt for $FULL_IMAGE..."
      sleep 10
    done

    if [ $attempt -ge 3 ]; then
      echo "Build failed for $FULL_IMAGE after 3 attempts"
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
