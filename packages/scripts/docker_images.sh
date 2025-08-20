#!/bin/bash
set -e
set -o pipefail

# Usage:
# ./script.sh /path/to/context image_name tag1,tag2,tag3 [/another/path image_name tagX,tagY]

if [ "$#" -lt 3 ]; then
  echo "Usage: $0 /path/to/context image_name tag1,tag2,tag3 [/another/path image_name tagX,tagY ...]"
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
    echo "Tags: ${TAGS[*]}"

    # Build docker buildx command with multiple tags
    DOCKER_CMD="docker buildx build --platform linux/amd64,linux/arm64 --progress=plain --no-cache"
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
