// Runs INSIDE a privileged node:24-alpine container of the sandbox daemon (see
// enospc.mjs). Real kernel ENOSPC: a 64 KiB tmpfs is filled to 0 bytes free and
// safeWriteFile (the real bundle, a real fs) writes to it. Prints one JSON line per
// case: {"case","ok","detail"}.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { execSync } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');

const { safeWriteFile, DiskFullError } = require('/work/safeWriteFile.cjs');

const SMALL = '/small';
const TARGET_DIR = '/target';
const BOUND = `${TARGET_DIR}/compose.yml`;
const fsyncAsync = promisify(fs.fsync);

// Same shape as realFs in safeWriteFile.ts, except that statfs fails the way it does
// on a filesystem without statfs (ENOSYS): that is a supported production path and
// the one that lets the write reach the kernel's ENOSPC instead of being refused up front.
const noStatfsFs = {
  open: async (p, flags, mode) => {
    const handle = await fsp.open(p, flags, mode);
    return {
      read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
      write: (buffer, offset, length, position) => handle.write(buffer, offset, length, position),
      truncate: length => handle.truncate(length),
      sync: () => fsyncAsync(handle.fd),
      chmod: mode2 => handle.chmod(mode2),
      close: () => handle.close(),
    };
  },
  stat: p => fsp.stat(p),
  statfs: async () => {
    throw Object.assign(new Error('statfs not supported'), { code: 'ENOSYS' });
  },
  rename: (from, to) => fsp.rename(from, to),
  unlink: p => fsp.unlink(p),
  readFile: p => fsp.readFile(p),
};

const sh = cmd => execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const tryShell = cmd => {
  try {
    sh(cmd);
  } catch {
    // nothing mounted yet
  }
};

const emit = (name, ok, detail) => process.stdout.write(`${JSON.stringify({ case: name, ok, detail })}\n`);

// Valid YAML of exactly `size` bytes: a services mapping, then comment padding.
const yamlOf = (size, image, extraServices = 0) => {
  const services = [`services:`, `  web:`, `    image: ${image}`, `    restart: unless-stopped`]
    .concat(Array.from({ length: extraServices }, (_, i) => [`  extra${i}:`, `    image: busybox:${i}`]).flat())
    .join('\n');
  const head = `${services}\n`;
  const pad = size - head.length;
  if (pad < 2) throw new Error(`content larger than ${size}`);
  const comment = `# ${'x'.repeat(pad - 3)}\n`;
  const body = Buffer.from(head + comment);
  if (body.length !== size) throw new Error(`yaml is ${body.length} bytes, wanted ${size}`);
  return body;
};

const freshTmpfs = () => {
  tryShell(`umount ${BOUND}`);
  tryShell(`umount ${SMALL}`);
  fs.mkdirSync(SMALL, { recursive: true });
  fs.mkdirSync(TARGET_DIR, { recursive: true });
  fs.rmSync(BOUND, { force: true });
  sh(`mount -t tmpfs -o size=64k,nr_inodes=64 tmpfs ${SMALL}`);
};

const fillToZero = () => {
  try {
    sh(`dd if=/dev/zero of=${SMALL}/.filler bs=1k 2>&1`);
  } catch {
    // dd exits 1 on the ENOSPC it is meant to hit
  }
  fs.fsyncSync(fs.openSync(`${SMALL}/.filler`, 'r'));
};

const freeBytes = () => {
  const s = fs.statfsSync(SMALL);
  return Number(s.bavail) * Number(s.bsize);
};

// Case A/B/D file: /small/compose.yml bind-mounted over /target/compose.yml.
const bindSetup = (oldBytes) => {
  freshTmpfs();
  fs.writeFileSync(`${SMALL}/compose.yml`, oldBytes);
  fs.writeFileSync(BOUND, 'placeholder\n');
  sh(`mount --bind ${SMALL}/compose.yml ${BOUND}`);
  fillToZero();
  const free = freeBytes();
  const dirDev = fs.statSync(TARGET_DIR).dev;
  const fileStat = fs.statSync(BOUND);
  return { free, separateMount: fileStat.dev !== dirDev, ino: fileStat.ino };
};

const writeOutcome = async (file, content, options = {}) => {
  try {
    await safeWriteFile(file, content, { fs: noStatfsFs, ...options });
    return { threw: false };
  } catch (error) {
    return { threw: true, error, diskFull: error instanceof DiskFullError || error?.code === 'ENOSPC' };
  }
};

// The kernel's own errno behind a DiskFullError (proves it was not our pre-flight).
const kernelCause = o => (o.threw ? o.error?.cause?.syscall ? `${o.error.cause.syscall}:${o.error.cause.code}` : o.error?.cause?.code ?? 'none' : undefined);
const describe = o => (o.threw ? `threw ${o.error?.name}/${o.error?.code} (kernel ${kernelCause(o)})` : 'returned');

const caseA = async size => {
  const name = `A.in-place-grow.${size}`;
  const old = yamlOf(size, 'app:1');
  const next = Buffer.concat([yamlOf(size, 'app:2').subarray(0, size - 1), Buffer.from('\n'), Buffer.from(`  extra:\n    image: busybox:latest\n    command: ${'y'.repeat(300)}\n`)]);
  const s = bindSetup(old);
  if (!s.separateMount) return emit(name, false, 'harness: bind-mounted file shares its directory device');
  if (s.free !== 0) return emit(name, false, `harness: ${s.free} bytes free, wanted 0`);
  const out = await writeOutcome(BOUND, next);
  const after = fs.readFileSync(BOUND);
  const inoAfter = fs.statSync(BOUND).ino;
  const checks = {
    threw: out.threw,
    diskFull: out.diskFull,
    bytesIdentical: after.equals(old),
    inodeUnchanged: inoAfter === s.ino,
  };
  const ok = Object.values(checks).every(Boolean);
  return emit(name, ok, { ...checks, outcome: describe(out), size: after.length, oldSize: old.length, newSize: next.length, free: s.free, strategy: 'in-place (separate mount)', code: out.error?.code, kernelCause: kernelCause(out) });
};

const caseB = async () => {
  const size = 4096;
  const old = yamlOf(size, 'app:1');
  const variants = [
    ['shrink', Buffer.from('services:\n  web:\n    image: app:2\n')],
    ['same-size', yamlOf(size, 'app:9')],
  ];
  for (const [label, next] of variants) {
    const name = `B.in-place-${label}`;
    const s = bindSetup(old);
    const out = await writeOutcome(BOUND, next);
    const after = fs.readFileSync(BOUND);
    const checks = { succeeded: !out.threw, bytesEqualNew: after.equals(next), inodeUnchanged: fs.statSync(BOUND).ino === s.ino };
    emit(name, Object.values(checks).every(Boolean) && s.free === 0, { ...checks, outcome: describe(out), error: out.error?.message, size: after.length, newSize: next.length, free: s.free });
  }
};

const caseC = async () => {
  const name = 'C.replace-dir-on-tmpfs';
  const size = 4096;
  const old = yamlOf(size, 'app:1');
  freshTmpfs();
  fs.mkdirSync(`${SMALL}/dir`);
  const target = `${SMALL}/dir/compose.yml`;
  fs.writeFileSync(target, old);
  fillToZero();
  const free = freeBytes();
  const sameDev = fs.statSync(target).dev === fs.statSync(`${SMALL}/dir`).dev;
  const next = Buffer.concat([old.subarray(0, 100), Buffer.from('CHANGED'), old.subarray(107), Buffer.from(`  extra:\n    command: ${'z'.repeat(400)}\n`)]);
  const out = await writeOutcome(target, next);
  const after = fs.readFileSync(target);
  const leftovers = fs.readdirSync(`${SMALL}/dir`).filter(f => /^\.compose\.yml\..*\.tmp$/.test(f));
  const checks = { threw: out.threw, diskFull: out.diskFull, bytesIdentical: after.equals(old), noTmpLeft: leftovers.length === 0, sameDev };
  emit(name, Object.values(checks).every(Boolean) && free === 0, { ...checks, outcome: describe(out), size: after.length, free, leftovers, code: out.error?.code });
};

const caseD = async () => {
  const name = 'D.control-plain-writeFile';
  const size = 4096;
  const old = yamlOf(size, 'app:1');
  const next = Buffer.concat([yamlOf(size, 'app:2').subarray(0, size - 1), Buffer.from('\n'), Buffer.from(`  extra:\n    image: busybox:latest\n    command: ${'y'.repeat(300)}\n`)]);
  const s = bindSetup(old);
  let threw;
  try {
    await fsp.writeFile(BOUND, next);
  } catch (error) {
    threw = error.code;
  }
  const after = fs.readFileSync(BOUND);
  process.stderr.write(`control: plain writeFile left ${after.length} bytes\n`);
  const corrupted = !after.equals(old) && !after.equals(next);
  // ok = the bug reproduced (file is neither the old nor the new bytes).
  emit(name, corrupted && threw === 'ENOSPC', { controlLeftBytes: after.length, text: `control: plain writeFile left ${after.length} bytes`, writeError: threw, equalsOld: after.equals(old), equalsNew: after.equals(next), oldSize: old.length, free: s.free });
};

const main = async () => {
  const cases = [() => caseA(4096), () => caseA(8192), caseB, caseC, caseD];
  for (const c of cases) {
    try {
      await c();
    } catch (e) {
      emit(`harness-error.${c.name || 'case'}`, false, String(e && e.stack ? e.stack : e));
    }
  }
  tryShell(`umount ${BOUND}`);
  tryShell(`umount ${SMALL}`);
};

main();
