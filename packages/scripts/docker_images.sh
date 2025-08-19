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
  FULL_IMAGE_NAME="$2"
  shift 2

  (
    cd "$CONTEXT" || { echo "Failed to enter $CONTEXT"; exit 1; }
    echo "Building $FULL_IMAGE_NAME from context: $CONTEXT"
    docker buildx build \
      --platform linux/amd64,linux/arm64 \
      --progress=plain \
      --no-cache \
      -t "$FULL_IMAGE_NAME" \
      --push .
      
  ) &
  
  pids+=($!)
done

# Wait for all background jobs and check exit codes
for pid in "${pids[@]}"; do
  wait $pid || errors+=($pid)
done

if [ "${#errors[@]}" -ne 0 ]; then
  echo "Some builds failed: ${errors[*]}"
  exit 1
fi

echo "All builds finished successfully."
