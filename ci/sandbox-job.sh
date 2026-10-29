#!/bin/sh
# One shard of the conductor sandbox. Run by the `sandbox` job of .gitlab-ci.yml, and by hand to
# reproduce a CI shard (see "In CI" in sandbox/README.md).
#
# It expects what the job has: a privileged container from conductor-sandbox-ci (docker:28.3.3-dind
# plus node, yarn and the sandbox's npm dependencies, see ci/sandbox-ci.Dockerfile; alpine, busybox
# sh), the repository checked out, and packages/gluesync-conductor/build from build_artifacts. The
# container runs its own dockerd, so concurrent jobs never share a daemon and the sandbox's
# bind-mount paths (under the checkout) exist for the daemon that mounts them.
#
# Nothing is downloaded here: node, yarn and the npm dependencies are in the image, and with
# SANDBOX_IMAGE_MIRROR set the sandbox pulls its images from that registry instead of Docker Hub.
# A missing tool is an error, never an install.
#
#   CI_NODE_INDEX / CI_NODE_TOTAL   the shard (default 1/1: everything)
#   SANDBOX_IMAGE_MIRROR            registry/repo holding the sandbox's images (see sandbox/lib/env.mjs)
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
die() { log "$*"; exit 1; }

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
  DOCKERD_PID=$!
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

# The CI image has node, yarn (prepared by corepack, which cannot download) and the sandbox's npm
# dependencies in /opt/sandbox-deps. Fail loudly rather than fetch anything.
check_tools() {
  command -v node >/dev/null 2>&1 || die "node is missing: run this in conductor-sandbox-ci (ci/sandbox-ci.Dockerfile)"
  # Only the enospc test needs yarn: it bundles safeWriteFile with the repo's esbuild through Yarn
  # PnP. .pnp.cjs and .yarn/cache are committed; the unplugged esbuild is materialized offline from
  # that cache before the test (see the end of this script).
  command -v yarn >/dev/null 2>&1 || die "yarn is missing: run this in conductor-sandbox-ci (ci/sandbox-ci.Dockerfile)"
  log "node $(node --version), yarn $(yarn --version)"
}

link_sandbox_deps() {
  deps=${SANDBOX_DEPS_DIR:-/opt/sandbox-deps}
  [ -d "$deps/node_modules" ] || die "$deps/node_modules is missing: run this in conductor-sandbox-ci (ci/sandbox-ci.Dockerfile)"
  # The package-lock the image was built from must be the checkout's, or the sandbox could run on
  # other versions than the ones it pins.
  cmp -s "$deps/package-lock.json" "$ROOT/sandbox/package-lock.json" ||
    die "sandbox/package-lock.json differs from the one in the image: rebuild and push the image, bump its tag (ci/sandbox-ci.Dockerfile)"
  rm -rf "$ROOT/sandbox/node_modules"
  ln -s "$deps/node_modules" "$ROOT/sandbox/node_modules"
}

# Every phase has its own time budget (seconds), so a hang fails the job with a message long before
# the job's own 60 minute timeout: busybox `timeout` sends TERM, then KILL 15 s later. Tuned for the
# whole job to fit in 60 minutes; override from the environment when running by hand.
UP_BUDGET=${SANDBOX_UP_BUDGET:-600}
ITERATE_BUDGET=${SANDBOX_ITERATE_BUDGET:-2400}
ENOSPC_BUDGET=${SANDBOX_ENOSPC_BUDGET:-420}
TEARDOWN_BUDGET=${SANDBOX_TEARDOWN_BUDGET:-90}

# phase NAME SECONDS COMMAND...: runs the command under `timeout` and says why it failed.
phase() {
  name=$1; budget=$2; shift 2
  log "$name (budget ${budget}s)"
  rc=0
  timeout -k 15 "$budget" "$@" || rc=$?
  if [ "$rc" -eq 124 ] || [ "$rc" -eq 143 ] || [ "$rc" -eq 137 ]; then
    log "$name HUNG: killed after ${budget}s (exit $rc)"
  elif [ "$rc" -ne 0 ]; then
    log "$name failed (exit $rc)"
  fi
  return "$rc"
}

# Leaves nothing in the daemon behind, whatever the outcome (the daemon dies with the job anyway;
# this is for runs on a long-lived daemon, i.e. a developer's machine). Bounded: a daemon that stopped
# answering must not keep the job `running`. Then the background dockerd is stopped too.
teardown() {
  trap - EXIT
  (cd "$ROOT/sandbox" && timeout -k 10 "$TEARDOWN_BUDGET" node run.mjs down --purge) || log "teardown did not finish cleanly (ignored)"
  if [ -n "${DOCKERD_PID:-}" ]; then
    kill "$DOCKERD_PID" 2>/dev/null || true
  fi
}

check_tools
link_sandbox_deps
start_dockerd
cd "$ROOT/sandbox"
trap teardown EXIT
# A cancelled job gets TERM: run the teardown through EXIT.
trap 'exit 143' TERM INT

phase "up" "$UP_BUDGET" node run.mjs up

# SANDBOX_JOB_ONLY=disk-check: only the disk fault self check, no iterations (diagnosing a runner).
if [ "${SANDBOX_JOB_ONLY:-}" = disk-check ]; then
  phase "disk-check" 180 node run.mjs disk-check
  exit $?
fi

rc=0
phase "iterate" "$ITERATE_BUDGET" node run.mjs iterate --profiles all --shard "$SHARD_INDEX/$SHARD_TOTAL" || rc=$?
if [ "$SHARD_INDEX" = 1 ]; then
  # enospc bundles safeWriteFile with the repo's esbuild through Yarn PnP. .pnp.cjs and .yarn/cache are
  # committed, but .yarn/unplugged (esbuild's binary) is not: materialize it from the committed cache,
  # network off, so nothing can be downloaded.
  phase "yarn install (offline, for the enospc bundle)" 300 sh -c "cd '$ROOT' && YARN_ENABLE_NETWORK=0 yarn install --immutable --immutable-cache" || rc=$?
  phase "enospc" "$ENOSPC_BUDGET" node run.mjs enospc || rc=$?
fi
exit "$rc"
