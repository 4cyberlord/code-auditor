#!/usr/bin/env bash
# Operator-only container entry point. The host provides only a reviewed
# manifest and candidate directory. No credentials or network are forwarded.
set -Eeuo pipefail
if [ "$#" -ne 2 ]; then
  echo "Usage: bash scripts/run-benchmark-container.sh /absolute/reviewed-workspace /absolute/output-dir" >&2
  exit 2
fi
workspace="$(cd "$1" && pwd -P)"
output="$(cd "$2" && pwd -P)"
[ -f "$workspace/manifest.json" ] || { echo "Missing reviewed manifest.json" >&2; exit 2; }
[ "$workspace" != "$output" ] || { echo "Output must be separate from input workspace" >&2; exit 2; }
image="public.ecr.aws/docker/library/node:22-alpine"
docker run --rm --pull never \
  --network none --read-only --ipc none \
  --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit 64 --memory 512m --memory-swap 512m --cpus 1 \
  --ulimit nofile=256:256 --ulimit fsize=8388608:8388608 \
  --tmpfs /tmp:rw,nosuid,size=64m \
  --user 1000:1000 \
  --mount "type=bind,source=$workspace,target=/workspace,readonly" \
  --mount "type=bind,source=$output,target=/output" \
  -e COUNCIL_TRUSTED_BENCHMARK_ENV=isolated-operator \
  -e COUNCIL_BENCHMARK_ROOT=/workspace \
  --workdir /workspace \
  "$image" node /workspace/run-benchmark.mjs /workspace/manifest.json /output/unreviewed.json
