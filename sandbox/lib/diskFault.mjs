// Disk-full faults for the compose file, injected without touching the host disk.
//
// The conductor reads and writes its compose file through a single-file bind mount
// (./docker-compose.yml:/opt/gluesync-conductor/docker-compose.yml), like the Linux
// kits. To make that file's filesystem run out of space the runner enters the
// conductor container's mount namespace from the privileged Docker-in-Docker
// container (nsenter -t <pid> -m) and, in there:
//
//   1. mounts a small tmpfs (256 KiB) at /run/sbx-disk
//   2. copies the compose file into it
//   3. bind-mounts that copy over /opt/gluesync-conductor/docker-compose.yml
//   4. fills the tmpfs with a filler file down to the wanted free space
//
// While the fault is active the host copy of the compose file is NOT what the
// conductor sees; readLiveCompose() and the stream sampler read the tmpfs copy
// through /proc/<pid>/root. releaseDiskFault() copies the tmpfs bytes back to the
// host file (in place, never truncating), unmounts both mounts and is safe to call
// at any time, any number of times, also for a conductor that was replaced (its
// mount namespace and the mounts went with it) or for mounts left by a dead runner.
//
// The mounts live in the namespace of one conductor container. They must not be
// held across the conductor's self-update: its helper container recreates the
// conductor from the HOST compose file. Profiles therefore only inject the fault
// when no self-update is about to run (or when the update is refused up front).
//
// Docker Desktop for Mac (gRPC FUSE) leaves that single-file bind "stale" a few seconds
// after the host file is written (mountinfo root ends in //deleted) and the kernel then
// refuses the bind in step 3. startNow detects it and restarts the conductor container
// (same id, sandbox only) to re-resolve the bind; native Linux binds never go stale.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { env } from './env.mjs';
import { composeProblem } from './composeSampler.mjs';
import { conductorContainer, waitConductor } from './stack.mjs';
import { docker, dockerBin, run, sleep } from './util.mjs';

const COMPOSE = '/opt/gluesync-conductor/docker-compose.yml';
const MOUNT_DIR = '/run/sbx-disk';
const TMPFS = 'sbx-disk';
const STOP_FILE = '/run/sbx-compose-sampler.stop';
const hostCompose = () => path.join(env.kitDir, 'docker-compose.yml');

// ---------------------------------------------------------------- running things in the conductor's namespace

const inDind = (args, opts = {}) => run(dockerBin(), ['exec', env.dindName, ...args], opts);

// The DinD image is alpine: its busybox has nsenter. If it ever does not, a
// privileged helper container sharing the daemon's pid namespace does the same.
let nsenterInDind = null;
const nsCommand = async (pid, script, helperName) => {
  if (nsenterInDind === null) nsenterInDind = (await inDind(['sh', '-c', 'command -v nsenter'])).code === 0;
  // -p as well: df and the mountinfo lookups need /proc/self, which only exists
  // for processes inside the container's pid namespace.
  const nsenter = ['nsenter', '-t', String(pid), '-m', '-p', 'sh', '-c', script];
  if (nsenterInDind) return { args: ['exec', env.dindName, ...nsenter], docker: false };
  const name = helperName ? ['--name', helperName] : [];
  return { args: ['run', '--rm', ...name, '--privileged', '--pid=host', 'alpine:3.20', ...nsenter], docker: true };
};

const inConductor = async (pid, script, opts = {}) => {
  const cmd = await nsCommand(pid, script);
  return run(dockerBin(), cmd.args, { docker: cmd.docker, timeoutMs: 30000, ...opts });
};

// Shell helpers every script shares. `mine` counts the bind mount this module put
// over the compose file (told apart from Docker's own by the tmpfs source name).
const PRELUDE = `
F=${COMPOSE}
M=${MOUNT_DIR}
stale() { awk -v f="$F" '$5 == f && $4 ~ "//deleted$" && !/ - tmpfs ${TMPFS} /' /proc/self/mountinfo | wc -l | tr -d ' '; }
mine() { awk -v f="$F" '$5 == f && / - tmpfs ${TMPFS} /' /proc/self/mountinfo | wc -l | tr -d ' '; }
avail() { df -k "$M" | awk 'NR==2 {print $4}'; }
fill_to() {
  rm -f "$M/.filler"
  if [ "$1" -le 0 ]; then
    dd if=/dev/zero of="$M/.filler" bs=1k 2>/dev/null || true
  else
    n=$(( $(avail) - $1 ))
    if [ "$n" -gt 0 ]; then dd if=/dev/zero of="$M/.filler" bs=1k count="$n" 2>/dev/null || true; fi
  fi
}
`;

const setupScript = (sizeKiB, freeKiB) => `set -e
${PRELUDE}
mkdir -p "$M"
i=0
while awk -v m="$M" '$5 == m {f=1} END {exit !f}' /proc/self/mountinfo && [ $i -lt 4 ]; do
  umount "$M" || umount -l "$M" || break
  i=$((i + 1))
done
mount -t tmpfs -o size=${sizeKiB}k ${TMPFS} "$M"
cat "$F" > "$M/compose.yml"
mount -o bind "$M/compose.yml" "$F"
fill_to ${freeKiB}
echo "free_kib=$(avail) compose_bytes=$(wc -c < "$M/compose.yml" | tr -d ' ')"
`;

// Free space toggles between none (a filler file takes it all) and openKiB, every 20-50 ms.
const flapScript = openKiB => `${PRELUDE}
touch "$M/.flap"
i=0
while [ -e "$M/.flap" ] && [ $i -lt 6000 ]; do
  case $((i % 3)) in 0) a=0.02; b=0.05;; 1) a=0.04; b=0.03;; *) a=0.05; b=0.02;; esac
  dd if=/dev/zero of="$M/.fB" bs=1k count=${openKiB} 2>/dev/null
  sleep $a
  rm -f "$M/.fB"
  sleep $b
  i=$((i + 1))
done
rm -f "$M/.fB"
`;

const grabScript = `${PRELUDE}
if [ "$(mine)" -eq 0 ]; then echo NOMOUNT; exit 0; fi
echo MOUNT
base64 "$F"
`;

const staleScript = `${PRELUDE}
echo "stale=$(stale)"
`;

const teardownScript = `${PRELUDE}
rm -f "$M/.flap"
i=0
while [ "$(mine)" -gt 0 ] && [ $i -lt 4 ]; do
  umount "$F" 2>/dev/null || umount -l "$F" 2>/dev/null || break
  i=$((i + 1))
done
umount "$M" 2>/dev/null || umount -l "$M" 2>/dev/null || true
rmdir "$M" 2>/dev/null || true
echo "left=$(mine)"
`;

// ---------------------------------------------------------------- state

const state = { pid: null, containerId: null, sampler: null, flap: null, stream: null };
let chain = Promise.resolve();
// Start and release never overlap.
const exclusive = fn => {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
};

export const diskFaultActive = () => state.pid !== null;

// ---------------------------------------------------------------- stream sampler

// A shell loop in the DinD container reads the conductor's view of the compose file
// (/proc/<pid>/root/...) every 25 ms and prints it between markers; a docker exec
// per sample would be too slow. The conductor's mount namespace is not reachable
// from the host, so this is the way to see the tmpfs copy at that rate.
const streamScript = pid => String.raw`
P=/proc/${pid}/root${COMPOSE}
rm -f ${STOP_FILE}
i=0
while [ ! -e ${STOP_FILE} ] && [ $i -lt 40000 ]; do
  if [ -r "$P" ]; then echo '@@S'; cat "$P"; printf '\n@@E\n'; else echo '@@N'; fi
  i=$((i + 1))
  sleep 0.025
done
`;

const startStream = (pid, sampler) => {
  const child = spawn(dockerBin(), ['exec', env.dindName, 'sh', '-c', streamScript(pid)], { stdio: ['ignore', 'pipe', 'ignore'] });
  child.stdout.setEncoding('utf8');
  let buf = '';
  child.stdout.on('data', chunk => {
    buf = (buf + chunk).replaceAll('@@N\n', '');
    for (let m = /@@S\n([\s\S]*?)\n@@E\n/.exec(buf); m; m = /@@S\n([\s\S]*?)\n@@E\n/.exec(buf)) {
      sampler?.push(m[1], 'conductor-ns');
      buf = buf.slice(m.index + m[0].length);
    }
  });
  child.on('close', () => {
    if (state.stream === child) state.stream = null;
    // Back to reading the host copy if the stream dies on its own.
    if (sampler && !state.stream) sampler.external = false;
  });
  state.stream = child;
  if (sampler) sampler.external = true;
};

const waitClosed = (child, ms) =>
  new Promise(resolve => {
    if (child?.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, ms);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });

const stopStream = async () => {
  const child = state.stream;
  if (!child) return;
  await inDind(['touch', STOP_FILE]);
  await waitClosed(child, 3000);
  state.stream = null;
  await inDind(['rm', '-f', STOP_FILE]);
};

// ---------------------------------------------------------------- helpers on the host copy

// Same technique the conductor uses: never truncate first, so a reader never sees
// an empty file. Pad to the longer length, then cut to the new one.
const overwriteInPlace = (file, buf) => {
  const fd = fs.openSync(file, 'r+');
  try {
    const old = fs.fstatSync(fd).size;
    const padded = old > buf.length ? Buffer.concat([buf, Buffer.alloc(old - buf.length, 10)]) : buf;
    let written = 0;
    while (written < padded.length) written += fs.writeSync(fd, padded, written, padded.length - written, written);
    fs.ftruncateSync(fd, buf.length);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
};

const readHostCompose = () => {
  try {
    return fs.readFileSync(hostCompose());
  } catch {
    return Buffer.alloc(0);
  }
};

// ---------------------------------------------------------------- stop / release

const stopFlapping = async () => {
  const child = state.flap;
  if (!child) return;
  if (state.pid) await inConductor(state.pid, `rm -f ${MOUNT_DIR}/.flap`);
  await waitClosed(child, 3000);
  state.flap = null;
};

// Copies the conductor's view back to the host file when it changed, unless it is
// unusable (then the host copy stays, so the next iteration starts from a valid file).
const copyBack = (b64, it) => {
  const live = Buffer.from(b64, 'base64');
  const host = readHostCompose();
  if (live.equals(host)) return 'unchanged';
  const problem = composeProblem(live.toString('utf8'));
  if (problem) {
    it?.notes.push(`disk fault: the compose file the conductor saw was ${problem}; kept the host copy`);
    return `not copied back (${problem})`;
  }
  overwriteInPlace(hostCompose(), live);
  it?.notes.push(`disk fault: the conductor rewrote the compose file under the fault (${host.length} -> ${live.length} bytes); copied it back to the host`);
  return 'copied back';
};

const releaseNow = async it => {
  await stopFlapping();
  await stopStream();
  const wasActive = state.pid !== null;
  const sampler = state.sampler;
  const c = await conductorContainer();
  let summary;
  if (!c) {
    summary = { released: false, replaced: wasActive, copy: null };
  } else {
    // Whatever container runs now: the mounts of a runner that died are found too.
    const grab = await inConductor(c.pid, grabScript);
    const [head, ...b64] = grab.out.split('\n');
    const mounted = grab.code === 0 && head === 'MOUNT';
    const copy = mounted ? copyBack(b64.join(''), it) : null;
    if (mounted) {
      const down = await inConductor(c.pid, teardownScript);
      if (!/left=0/.test(down.out)) it?.notes.push(`disk fault: unmount left something behind: ${down.err || down.out}`);
    }
    summary = { released: mounted, replaced: wasActive && !mounted && c.id !== state.containerId, copy };
  }
  if (summary.replaced) it?.notes.push('disk fault: the conductor container was replaced during the iteration; its mounts went with it');
  Object.assign(state, { pid: null, containerId: null, flap: null, stream: null, sampler: null });
  if (sampler) sampler.external = false;
  return summary;
};

// Safe to call at any time: with no fault active it only checks the running conductor.
export const releaseDiskFault = it => exclusive(() => releaseNow(it));

// ---------------------------------------------------------------- start

// True when the conductor's own compose bind is stale (see the header): the kernel
// would refuse to mount over it. A failed probe counts as not stale.
const bindStale = async pid => {
  const r = await inConductor(pid, staleScript);
  return r.code === 0 && /stale=[1-9]/.test(r.out);
};

// Restarts the conductor container (same id, RestartCount untouched) so Docker
// re-resolves the compose bind, then waits for /health. Returns the fresh container.
const healStaleBind = async (c, it) => {
  const r = await docker(['restart', c.id], { timeoutMs: 90000 });
  if (r.code !== 0) throw new Error(`could not restart conductor ${c.id} to refresh its stale compose bind: ${(r.err || r.out).slice(-400)}`);
  const up = await waitConductor({ timeoutMs: 120000 });
  if (!up.ok) throw new Error(`conductor ${c.id} did not answer /health after the restart that refreshes its stale compose bind (last: ${up.last})`);
  it?.notes.push(`disk fault: Docker Desktop file sharing left the conductor's compose bind stale; restarted conductor ${c.id} to re-resolve it (sandbox only)`);
  return up.value;
};

const startNow = async (ctx, it, { freeKiB, sizeKiB = 256, flap = false }) => {
  await releaseNow(it);
  let c = await conductorContainer();
  if (!c) throw new Error('no running conductor to inject the disk fault into');
  if (await bindStale(c.pid)) c = await healStaleBind(c, it);
  Object.assign(state, { pid: c.pid, containerId: c.id, sampler: ctx.sampler || null });
  let r = await inConductor(c.pid, setupScript(sizeKiB, freeKiB));
  // It can go stale between the check and the mount: heal once and retry once.
  if (r.code !== 0 && (await bindStale(c.pid))) {
    try {
      c = await healStaleBind(c, it);
    } catch (e) {
      await releaseNow(it).catch(() => {});
      throw e;
    }
    Object.assign(state, { pid: c.pid, containerId: c.id });
    r = await inConductor(c.pid, setupScript(sizeKiB, freeKiB));
  }
  if (r.code !== 0) {
    await releaseNow(it).catch(() => {});
    throw new Error(`could not set up the disk fault in conductor ${c.id}: ${(r.err || r.out).slice(-400)}`);
  }
  it?.notes.push(`disk fault in conductor ${c.id} (pid ${c.pid}): ${r.out.split('\n').at(-1)}, tmpfs ${sizeKiB} KiB${flap ? ', flapping' : ''}`);
  startStream(c.pid, ctx.sampler);
  if (flap) {
    const cmd = await nsCommand(c.pid, flapScript(freeKiB), `${env.keepPrefix}disk-fault`);
    const child = spawn(dockerBin(), cmd.args, {
      env: cmd.docker ? { ...process.env, DOCKER_HOST: env.dockerHost } : process.env,
      stdio: 'ignore',
    });
    child.on('close', () => {
      if (state.flap === child) state.flap = null;
    });
    state.flap = child;
    // Let the first full/free cycles happen before the update request goes out.
    await sleep(200);
  }
};

// freeKiB: free space left on the compose file's filesystem. flap: toggle between
// none and freeKiB. The conductor must be running; the fault ends with release.
export const startDiskFault = (ctx, it, options) => exclusive(() => startNow(ctx, it, options));

// ---------------------------------------------------------------- reading

// The compose file the way the conductor sees it right now, or null when it cannot be read.
export const readLiveCompose = async () => {
  if (state.pid === null) return fs.existsSync(hostCompose()) ? readHostCompose() : null;
  const r = await inConductor(state.pid, `base64 ${COMPOSE}`, { timeoutMs: 15000 });
  if (r.code !== 0) return null;
  return Buffer.from(r.out, 'base64');
};
