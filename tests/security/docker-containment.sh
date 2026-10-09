#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(mktemp -d)"
ID="council-coding-security-$$"
cleanup() {
  docker rm -f "$ID" >/dev/null 2>&1 || :
  rm -rf "$ROOT"
}
trap cleanup EXIT
mkdir -p "$ROOT/workspace"
chmod 777 "$ROOT/workspace"
printf 'visible\n' > "$ROOT/workspace/allowed.txt"
printf 'private\n' > "$ROOT/outside-secret.txt"
args=(
  run --rm --init --name "$ID"
  --pull never --network none --read-only --ipc none
  --cap-drop ALL --security-opt no-new-privileges
  --pids-limit 64 --ulimit nofile=256:256
  --ulimit fsize=8388608:8388608
  --memory 512m --memory-swap 512m --cpus 1
  --tmpfs /tmp:rw,nosuid,noexec,size=64m
  --user 1000:1000
  --mount "type=bind,source=$ROOT/workspace,target=/workspace"
  --workdir /workspace
  public.ecr.aws/docker/library/alpine:3.20 /bin/sh -ec
)
echo "Checking denied network, read-only root, confined host mounts, writable project, and tmpfs"
docker "${args[@]}" '
  test "$(cat /workspace/allowed.txt)" = "visible"
  printf "sandbox\n" > /workspace/output.txt
  test "$(cat /workspace/output.txt)" = "sandbox"
  if touch /etc/council-should-not-write 2>/dev/null; then echo "Root filesystem unexpectedly writable"; exit 1; fi
  if test -f /outside-secret.txt || test -f /workspace/../outside-secret.txt; then echo "Outside host file exposed"; exit 1; fi
  if ls /sys/class/net 2>/dev/null | grep -q "^eth0$"; then echo "Unexpected container network interface"; exit 1; fi
  test -w /tmp
  test ! -w /etc
'
echo "Checking runtime cgroup and capability configuration through Docker inspect"
docker "${args[@]}" 'sleep 25' >/dev/null 2>&1 &
client_pid=$!
for n in $(seq 1 50); do
  if docker inspect "$ID" >/dev/null 2>&1; then break; fi
  sleep 0.2
done
docker inspect "$ID" >/dev/null
[ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$ID")" = "none" ]
[ "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$ID")" = "true" ]
[ "$(docker inspect -f '{{.HostConfig.PidsLimit}}' "$ID")" = "64" ]
[ "$(docker inspect -f '{{.HostConfig.Memory}}' "$ID")" = "536870912" ]
[ "$(docker inspect -f '{{.HostConfig.MemorySwap}}' "$ID")" = "536870912" ]
[ "$(docker inspect -f '{{.HostConfig.NanoCpus}}' "$ID")" = "1000000000" ]
[ "$(docker inspect -f '{{.HostConfig.IpcMode}}' "$ID")" = "none" ]
[ "$(docker inspect -f '{{.HostConfig.Privileged}}' "$ID")" = "false" ]
[ "$(docker inspect -f '{{.HostConfig.SecurityOpt}}' "$ID")" = "[no-new-privileges]" ]
[ "$(docker inspect -f '{{.HostConfig.CapDrop}}' "$ID")" = "[ALL]" ]
[ "$(docker inspect -f '{{.Config.User}}' "$ID")" = "1000:1000" ]
echo "Checking forced termination of running container and its process tree"
docker rm -f "$ID" >/dev/null
if docker inspect "$ID" >/dev/null 2>&1; then
  echo "Container persists after forced termination"; exit 1
fi
wait "$client_pid" || :
echo "PASS: real Docker isolation, resource limits, filesystem boundary and cleanup"
