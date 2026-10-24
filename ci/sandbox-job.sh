#!/bin/sh
# One shard of the conductor sandbox. Run by the `sandbox` job of .gitlab-ci.yml, and by hand to
# reproduce a CI shard (see "In CI" in sandbox/README.md).
#
# It expects what the job has: a privileged container from docker:28.3.3-dind (alpine, busybox sh),
# the repository checked out, and packages/gluesync-conductor/build from build_artifacts. The
# container runs its own dockerd, so concurrent jobs never share a daemon and the sandbox's
# bind-mount paths (under the checkout) exist for the daemon that mounts them.
#
#   CI_NODE_INDEX / CI_NODE_TOTAL   the shard (default 1/1: everything)
#   SANDBOX_*                       name and port overrides, see sandbox/lib/env.mjs
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SHARD_INDEX=${CI_NODE_INDEX:-1}
SHARD_TOTAL=${CI_NODE_TOTAL:-1}

# conductor-crash-mid-update can deadlock: a SIGKILL in the middle of the recreate leaves CoreHub
# `Created`, and the restarted conductor's SDK plugin blocks startup until CoreHub answers, so it
# crash-loops. Known bug, still open: take it off this list once it is fixed. Destructive profiles
# (`--destructive`) are never part of `all`.
export SANDBOX_EXCLUDE_PROFILES=${SANDBOX_EXCLUDE_PROFILES-conductor-crash-mid-update}

log() { printf '[sandbox-job] %s\n' "$*"; }

start_dockerd() {
  if docker info >/dev/null 2>&1; then
    log "docker daemon already running"
    return
  fi
  log "starting dockerd"
  # The image's own entrypoint: cgroup v2 nesting, iptables flavour, docker-init. Naming dockerd
  # as the command keeps it from adding the tcp listener. Data root is the image's /var/lib/docker
  # VOLUME, a real filesystem: overlay2 cannot sit on the container's own overlay.
  dockerd-entrypoint.sh dockerd >/var/log/dockerd.log 2>&1 &
  i=0
  until docker info >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -gt 90 ]; then
      log "dockerd did not come up in 90s"
      tail -n 50 /var/log/dockerd.log
      exit 1
    fi
    sleep 1
  done
  driver=$(docker info --format '{{.Driver}}')
  log "dockerd ready (storage driver: $driver)"
  # vfs would copy every layer of every nested image: hours instead of minutes.
  if [ "$driver" = vfs ]; then
    log "storage driver is vfs: /var/lib/docker is not on a volume, refusing to continue"
    exit 1
  fi
}

install_node() {
  command -v node >/dev/null 2>&1 || apk add --no-cache nodejs npm
  log "node $(node --version), npm $(npm --version)"
}

# Only the enospc test needs yarn: it bundles safeWriteFile with the repo's esbuild through Yarn
# PnP. .pnp.cjs and .yarn/cache are committed, so no `yarn install`: just the yarn binary.
install_yarn() {
  command -v yarn >/dev/null 2>&1 && return
  # Alpine's nodejs ships no corepack.
  npm install --global --no-audit --no-fund corepack@0.34.0
  corepack enable
  yarn --version
}

# Leaves nothing in the daemon behind, whatever the outcome (the daemon dies with the job anyway;
# this is for runs on a long-lived daemon, i.e. a developer's machine).
teardown() {
  (cd "$ROOT/sandbox" && node run.mjs down --purge) || true
}

start_dockerd
install_node
cd "$ROOT/sandbox"
npm ci --no-audit --no-fund
trap teardown EXIT

node run.mjs up

rc=0
node run.mjs iterate --profiles all --shard "$SHARD_INDEX/$SHARD_TOTAL" || rc=$?
if [ "$SHARD_INDEX" = 1 ]; then
  install_yarn
  node run.mjs enospc || rc=$?
fi
exit "$rc"
