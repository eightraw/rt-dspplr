#!/usr/bin/env bash
# Generates synthetic example audio into storage/clips/ with Docker.
# Nothing here comes from real recordings: phrases are synthesised by
# espeak-ng, and the processed example audio is made with ffmpeg filters.
#
#   bash scripts/make-samples.sh        (or: npm run samples)
#
# Works from Git Bash on Windows (paths are passed to Docker in Windows form) and
# from a normal Linux/macOS shell.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STORAGE_DIR="$PROJECT_DIR/storage/clips"
IMAGE="rtd-samples:local"

to_docker_path() {
    if command -v cygpath >/dev/null 2>&1; then
        cygpath -m "$1"
    else
        printf '%s' "$1"
    fi
}

mkdir -p "$STORAGE_DIR"

echo "Building sample toolbox image ($IMAGE)..."
MSYS_NO_PATHCONV=1 docker build -q -t "$IMAGE" "$(to_docker_path "$SCRIPT_DIR/samples")" >/dev/null

echo "Rendering samples into storage/clips/ ..."
MSYS_NO_PATHCONV=1 docker run --rm \
    --network none \
    -v "$(to_docker_path "$STORAGE_DIR"):/out" \
    -v "$(to_docker_path "$SCRIPT_DIR/samples/render.sh"):/render.sh:ro" \
    "$IMAGE" sh /render.sh

echo "Done:"
ls -la "$STORAGE_DIR"
