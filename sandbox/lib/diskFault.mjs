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
// Nothing in there reads /proc (df, /proc/self/mountinfo): inside the conductor's mount namespace
// /proc is the container's own, and whether `df` finds its mount point there depends on the
// kernel and the busybox (on the CI runner it printed nothing, and the fault silently did not
// happen). The state of the fault is read from the Docker-in-Docker container instead, through
// /proc/<pid>/mountinfo and statfs on /proc/<pid>/root/..., which is the conductor's own view of the
// file. startNow() compares that view with what was asked and THROWS when the fault is not in
// place: a fault that silently does nothing would turn every disk-full profile into a misleading result.
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

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { env } from './env.mjs';
import { composeProblem } from './composeSampler.mjs';
import { conductorContainer } from './stack.mjs';
import { dockerBin, inSequence, run, say, sleep } from './util.mjs';

const COMPOSE = '/opt/gluesync-conductor/docker-compose.yml';
const MOUNT_DIR = '/run/sbx-disk';
const TMPFS = 'sbx-disk';
const TMPFS_MAGIC = 0x01021994;
const STOP_FILE = '/tmp/sbx-compose-sampler.stop';
const hostCompose = () => path.join(env.kitDir, 'docker-compose.yml');

// ---------------------------------------------------------------- running things in the conductor's namespace

const inDind = (args, opts = {}) => run(dockerBin(), ['exec', env.dindName, ...args], { timeoutMs: 30000, ...opts });

// The DinD image is alpine: its busybox has nsenter. If it ever does not, a
// privileged helper container sharing the daemon's pid namespace does the same.
let nsenterInDind = null;
const nsCommand = async (pid, script, helperName) => {
  if (nsenterInDind === null) nsenterInDind = (await inDind(['sh', '-c', 'command -v nsenter'])).code === 0;
  // Mount namespace only: the scripts below need no /proc (see the header).
  const nsenter = ['nsenter', '-t', String(pid), '-m', 'sh', '-c', script];
  if (nsenterInDind) return { args: ['exec', env.dindName, ...nsenter], docker: false };
  const name = helperName ? ['--name', helperName] : [];
  return { args: ['run', '--rm', ...name, '--privileged', '--pid=host', 'alpine:3.20', ...nsenter], docker: true };
};

const inConductor = async (pid, script, opts = {}) => {
  const cmd = await nsCommand(pid, script);
  return run(dockerBin(), cmd.args, { docker: cmd.docker, timeoutMs: 30000, ...opts });
};

// Shell variables every script shares.
const PRELUDE = `
F=${COMPOSE}
M=${MOUNT_DIR}
`;

// Page size of the tmpfs: free space is counted in whole pages.
const PAGE_KIB = 4;

// The filler file takes every free page (dd runs into ENOSPC), then is cut back so `keep` KiB stay
// free. No df: the size of the filler is what dd wrote.
const setupScript = (sizeKiB, freeKiB) => `set -e
${PRELUDE}
mkdir -p "$M"
mount -t tmpfs -o size=${sizeKiB}k ${TMPFS} "$M"
cat "$F" > "$M/compose.yml"
mount -o bind "$M/compose.yml" "$F"
dd if=/dev/zero of="$M/.filler" bs=1k 2>/dev/null || true
filled=$(wc -c < "$M/.filler" | tr -d ' ')
keep_kib=${Math.ceil(freeKiB / PAGE_KIB) * PAGE_KIB}
if [ "$keep_kib" -gt 0 ]; then
  kib=$(( filled / 1024 - keep_kib ))
  if [ "$kib" -lt 0 ]; then kib=0; fi
  dd if=/dev/null of="$M/.filler" bs=1k seek="$kib" 2>/dev/null
fi
echo "compose_bytes=$(wc -c < "$M/compose.yml" | tr -d ' ') filler_bytes=$(wc -c < "$M/.filler" | tr -d ' ')"
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

// One umount of the compose file's top mount (the caller only calls it while this module's tmpfs
// bind mount is the top one, never for Docker's own).
const unbindScript = `${PRELUDE}
umount "$F" 2>/dev/null || umount -l "$F"
`;

const teardownScript = `${PRELUDE}
rm -f "$M/.flap"
umount "$M" 2>/dev/null || umount -l "$M" 2>/dev/null || true
rmdir "$M" 2>/dev/null || true
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

// ---------------------------------------------------------------- the conductor's view, from outside

// Read from the Docker-in-Docker container, not from inside the conductor's namespaces (see the header).

const mountinfo = async pid => {
  const r = await inDind(['cat', `/proc/${pid}/mountinfo`]);
  return r.code === 0 ? r.out.split('\n') : null;
};

// This module's bind mounts over the compose file: told apart from Docker's own by the tmpfs
// source name. mountinfo: "id parent maj:min root mountpoint opts [optional...] - fstype source super".
const ourMounts = lines =>
  (lines || []).filter(line => {
    const f = line.split(' ');
    const dash = f.indexOf('-');
    return f[4] === COMPOSE && f[dash + 1] === 'tmpfs' && f[dash + 2] === TMPFS;
  });

// Filesystem type and free KiB of what `file` is on, in the conductor's mount namespace
// (/proc/<pid>/root/... resolves there). statfs on a path needs no mount table.
const statfsOf = async (pid, file) => {
  // %t is the filesystem magic in hex (busybox prints UNKNOWN for %T on most of them).
  const r = await inDind(['stat', '-f', '-c', '%t %a %S', `/proc/${pid}/root${file}`]);
  const m = /^([0-9a-f]+) (\d+) (\d+)$/.exec(r.out);
  if (!m) return { type: null, freeKiB: null, raw: (r.err || r.out).slice(0, 200) };
  return { type: Number.parseInt(m[1], 16) === TMPFS_MAGIC ? 'tmpfs' : `filesystem 0x${m[1]}`, freeKiB: Math.floor((Number(m[2]) * Number(m[3])) / 1024) };
};

const liveBytes = async pid => {
  const r = await inDind(['base64', `/proc/${pid}/root${COMPOSE}`]);
  return r.code === 0 ? Buffer.from(r.out.replaceAll('\n', ''), 'base64') : null;
};

// Everything that explains a fault that is not what was asked: for the error message and for
// `node run.mjs disk-check`.
export const diskFaultDiagnostics = async pid => {
  const section = async (title, r) => {
    const body = [r.out, r.err].filter(Boolean).join('\n') || `(nothing, exit ${r.code})`;
    return `--- ${title}\n${body}`;
  };
  const inside = script => inConductor(pid, script, { timeoutMs: 15000 });
  const parts = [
    await section('uname -a (docker-in-docker container)', await inDind(['uname', '-a'])),
    await section('nsenter', await inDind(['sh', '-c', 'command -v nsenter; busybox 2>&1 | head -1'])),
    await section(`/proc/${pid}/mountinfo, compose file and sbx-disk lines`, await inDind(['sh', '-c', `grep -E "sbx-disk|docker-compose.yml" /proc/${pid}/mountinfo`])),
    await section('statfs of the compose file, as the conductor sees it', await inDind(['stat', '-f', `/proc/${pid}/root${COMPOSE}`])),
    await section('statfs of the tmpfs directory', await inDind(['stat', '-f', `/proc/${pid}/root${MOUNT_DIR}`])),
    await section('inside the conductor: shell, /proc/self, df, mounts', await inside(`echo "sh pid $$"; ls -d /proc/self 2>&1; echo '$ df -k ${MOUNT_DIR}'; df -k ${MOUNT_DIR} 2>&1; echo "exit $?"; echo '$ stat -f'; stat -f ${MOUNT_DIR} 2>&1; echo '$ mount | grep sbx'; mount 2>&1 | grep sbx; ls -la ${MOUNT_DIR} 2>&1`)),
  ];
  return parts.join('\n');
};

// ---------------------------------------------------------------- stream sampler

// A shell loop in the DinD container reads the conductor's view of the compose file
// (/proc/<pid>/root/...) every 25 ms and prints it between markers; a docker exec
// per sample would be too slow. The conductor's mount namespace is not reachable
// from the host, so this is the way to see the tmpfs copy at that rate.
const streamScript = pid => `
P=/proc/${pid}/root${COMPOSE}
rm -f ${STOP_FILE}
i=0
while [ ! -e ${STOP_FILE} ] && [ $i -lt 40000 ]; do
  if [ -r "$P" ]; then echo '@@S'; cat "$P"; printf '\\n@@E\\n'; else echo '@@N'; fi
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
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
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

// One umount per bind mount of ours; never one more, that would be Docker's own. At most
// `attempts` of them, one after the other.
const unbindOurs = async (pid, attempts = 4) => {
  if (attempts === 0 || ourMounts(await mountinfo(pid)).length === 0) return;
  await inConductor(pid, unbindScript);
  await unbindOurs(pid, attempts - 1);
};

// Copies the conductor's view of the compose file back to the host; null when it cannot be read.
const copyLiveBack = async (pid, it) => {
  const live = await liveBytes(pid);
  if (live) return copyBack(live.toString('base64'), it);
  it?.notes.push('disk fault: the conductor view of the compose file could not be read when releasing; kept the host copy');
  return null;
};

// Releases whatever the running conductor container `c` holds of the fault.
const releaseFrom = async (c, wasActive, it) => {
  // Whatever container runs now: the mounts of a runner that died are found too.
  const mounted = ourMounts(await mountinfo(c.pid)).length > 0;
  let copy = null;
  if (mounted) {
    copy = await copyLiveBack(c.pid, it);
    await unbindOurs(c.pid);
  }
  await inConductor(c.pid, teardownScript);
  const left = ourMounts(await mountinfo(c.pid)).length;
  if (left > 0) it?.notes.push(`disk fault: ${left} mount(s) of the fault are still over the compose file after the release`);
  return { released: mounted, replaced: wasActive && !mounted && c.id !== state.containerId, copy };
};

const releaseNow = async it => {
  await stopFlapping();
  await stopStream();
  const wasActive = state.pid !== null;
  const sampler = state.sampler;
  const c = await conductorContainer();
  const summary = c ? await releaseFrom(c, wasActive, it) : { released: false, replaced: wasActive, copy: null };
  if (summary.replaced) it?.notes.push('disk fault: the conductor container was replaced during the iteration; its mounts went with it');
  Object.assign(state, { pid: null, containerId: null, flap: null, stream: null, sampler: null });
  if (sampler) sampler.external = false;
  return summary;
};

// Safe to call at any time: with no fault active it only checks the running conductor.
export const releaseDiskFault = it => exclusive(() => releaseNow(it));

// ---------------------------------------------------------------- start

// The fault is in place when the conductor's own view says so: exactly one tmpfs bind mount over
// the compose file, the file on a tmpfs, with the free space asked for (whole pages), and the bytes
// it holds are the host's. Returns what was seen; throws what is wrong.
const verifyFault = async (pid, freeKiB, hostBytes) => {
  const want = Math.ceil(freeKiB / PAGE_KIB) * PAGE_KIB;
  const mounts = ourMounts(await mountinfo(pid));
  const fsView = await statfsOf(pid, COMPOSE);
  const live = await liveBytes(pid);
  const problems = [];
  if (mounts.length !== 1) problems.push(`the conductor's mount table has ${mounts.length} tmpfs bind mount(s) over the compose file, expected 1`);
  const rawNote = fsView.raw ? ` (${fsView.raw})` : '';
  if (fsView.type !== 'tmpfs') problems.push(`the compose file is on "${fsView.type}" for the conductor, expected tmpfs${rawNote}`);
  if (fsView.freeKiB === null) problems.push('the free space of the compose file filesystem could not be read');
  else if (fsView.freeKiB !== want) problems.push(`the compose file filesystem has ${fsView.freeKiB} KiB free, expected ${want} (asked for ${freeKiB})`);
  if (!live?.equals(hostBytes)) problems.push('the compose bytes the conductor sees are not the host copy it was started from');
  if (problems.length) throw new Error(problems.join('; '));
  return { freeKiB: fsView.freeKiB, bytes: live.length };
};

const startNow = async (ctx, it, { freeKiB, sizeKiB = 256, flap = false }) => {
  await releaseNow(it);
  const c = await conductorContainer();
  if (!c) throw new Error('no running conductor to inject the disk fault into');
  Object.assign(state, { pid: c.pid, containerId: c.id, sampler: ctx.sampler || null });
  const fail = async (what, detail) => {
    const diagnostics = await diskFaultDiagnostics(c.pid).catch(e => `(diagnostics failed: ${e.message})`);
    await releaseNow(it).catch(() => {});
    const reason = detail ? `${what}: ${detail}` : what;
    throw new Error(`disk fault NOT in place in conductor ${c.id} (pid ${c.pid}): ${reason}\n${diagnostics}`);
  };
  const hostBytes = readHostCompose();
  const r = await inConductor(c.pid, setupScript(sizeKiB, freeKiB));
  if (r.code !== 0) await fail('setup script failed', (r.err || r.out).slice(-400));
  let seen;
  try {
    seen = await verifyFault(c.pid, freeKiB, hostBytes);
  } catch (e) {
    await fail('the fault is not what was asked', e.message);
  }
  it?.notes.push(`disk fault in conductor ${c.id} (pid ${c.pid}): ${r.out.split('\n').at(-1)}, tmpfs ${sizeKiB} KiB, ${seen.freeKiB} KiB free as the conductor sees it${flap ? ', flapping' : ''}`);
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
  return liveBytes(state.pid);
};

// ---------------------------------------------------------------- self check

// `node run.mjs disk-check`: injects each kind of fault on the running sandbox, prints what the
// conductor sees and what the namespaces look like (the diagnostics), releases it and checks that
// nothing is left. Throws on the first fault that is not in place, with the diagnostics.
export const diskFaultCheck = async () => {
  const c = await conductorContainer();
  if (!c) throw new Error('no running conductor');
  const before = readHostCompose();
  await inSequence([0, 32, 96], async freeKiB => {
    const it = { notes: [] };
    await startDiskFault({}, it, { freeKiB });
    say(it.notes.at(-1));
    if (freeKiB === 32) say(`diagnostics with ${freeKiB} KiB free:\n${await diskFaultDiagnostics(c.pid)}`);
    await releaseDiskFault(it);
    it.notes.forEach(n => say(`  ${n}`));
    const left = ourMounts(await mountinfo(c.pid)).length;
    if (left) throw new Error(`${left} mount(s) of the fault left after releasing (${freeKiB} KiB free)`);
    if (!readHostCompose().equals(before)) throw new Error('the host compose file changed across a fault that wrote nothing');
  });
  say('disk fault check: every fault was in place with the free space asked for, and fully released');
};
