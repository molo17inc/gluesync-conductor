// Real-kernel ENOSPC test for safeWriteFile (packages/gluesync-conductor/src/helpers/file/safeWriteFile).
//
// safeWriteFile's statfs pre-flight normally refuses a write before the kernel ever
// returns ENOSPC, and its unit tests use an in-memory fake fs. This puts the real
// bundle on a real 64 KiB tmpfs filled to 0 bytes free, inside a privileged
// node:24.22.1-alpine container of the sandbox daemon, with statfs reporting ENOSYS (a
// supported production path) so the write itself meets the kernel's ENOSPC.
//
//   A  single-file bind mount, in place, growing by a page: DiskFullError, bytes and inode untouched
//   B  same mount, shrinking and same-size content with 0 free: must succeed
//   C  directory on the tmpfs, replace strategy: ENOSPC, old bytes intact, no .tmp left
//   D  control: plain fs.writeFile on the case A setup corrupts the file (expected, proves the test bites)

import fs from 'node:fs';
import path from 'node:path';
import { env } from './env.mjs';
import { dindRunning, seedImages } from './setup.mjs';
import { writeJunit } from './junit.mjs';
import { docker, mustRun, now, say, writeJson } from './util.mjs';

const IMAGE = env.enospcImage;
const SAFE_WRITE_DIR = path.join(env.conductorPkgDir, 'src', 'helpers', 'file', 'safeWriteFile');
const here = path.dirname(new URL(import.meta.url).pathname);

// Case D passes when the bug reproduces, so its result is inverted.
const isControl = c => c.case.startsWith('D.');

const bundle = async outDir => {
  fs.mkdirSync(outDir, { recursive: true });
  const entry = path.join(outDir, 'entry.ts');
  fs.writeFileSync(
    entry,
    `export { default as safeWriteFile } from '${path.join(SAFE_WRITE_DIR, 'safeWriteFile')}';\n` +
      `export { DiskFullError } from '${path.join(SAFE_WRITE_DIR, 'safeWriteFile.errors')}';\n`,
  );
  // Yarn PnP: esbuild (the conductor build's bundler) only resolves from a workspace that depends on it.
  const r = await mustRun('yarn', ['node', path.join(here, 'enospcBundle.cjs'), env.repoDir, entry, path.join(outDir, 'safeWriteFile.cjs')], {
    cwd: path.join(env.repoDir, 'packages', 'scripts'),
    timeoutMs: 120000,
  });
  fs.copyFileSync(path.join(here, 'enospcDriver.cjs'), path.join(outDir, 'driver.cjs'));
  return r;
};

const table = results =>
  [
    `${'case'.padEnd(34)} ${'result'.padEnd(6)} detail`,
    ...results.map(r => `${r.case.padEnd(34)} ${(r.pass ? 'PASS' : 'FAIL').padEnd(6)} ${r.summary}${isControl(r) ? ' (inverted: bug reproduced)' : ''}`),
  ].join('\n');

const summarise = c => {
  const d = c.detail;
  if (typeof d === 'string') return d;
  if (isControl(c)) return d.text;
  const failed = Object.entries(d).filter(([, v]) => v === false).map(([k]) => k);
  if (failed.length) return `failed: ${failed.join(', ')} (${d.outcome ?? ''})`;
  const code = d.code ? ` ${d.code}` : '';
  return `${d.outcome ?? 'ok'}${code}, ${d.size ?? '?'} bytes`;
};

const markdown = (stamp, results, pass, container) =>
  [
    `# safeWriteFile real-kernel ENOSPC run ${stamp}`,
    '',
    `Result: **${pass ? 'PASS' : 'FAIL'}**. Image \`${IMAGE}\` (privileged, inside the sandbox daemon), 64 KiB tmpfs at /small, 0 bytes free, statfs injected as ENOSYS, CONDUCTOR_WRITE_RESERVE_BYTES=0.`,
    '',
    '| Case | Result | Detail |',
    '|---|---|---|',
    ...results.map(r => `| ${r.case} | ${r.pass ? 'PASS' : 'FAIL'}${isControl(r) ? ' (inverted: bug reproduced)' : ''} | ${r.summary.replaceAll('|', '/')} |`),
    '',
    '## Raw results',
    '',
    '```json',
    JSON.stringify(results.map(({ case: c, ok, detail }) => ({ case: c, ok, detail })), null, 2),
    '```',
    '',
    ...(container.stderr ? ['## Driver stderr', '', '```', container.stderr, '```', ''] : []),
  ].join('\n');

export const enospc = async () => {
  if (!(await dindRunning())) throw new Error('sandbox is not running: run `node run.mjs up` first');

  const startedAt = now();
  const outDir = path.join(env.runDir, 'enospc');
  say('bundling safeWriteFile with esbuild');
  await bundle(outDir);
  // Already there after `up`; this covers an `enospc` run against a daemon seeded by an older version.
  await seedImages([IMAGE], { inner: true });

  say('running the real-kernel ENOSPC cases in a privileged container');
  const r = await docker(
    [
      'run', '--rm', '--privileged', '--name', 'sbx-enospc',
      '-v', `${outDir}:/work:ro`,
      '-e', 'CONDUCTOR_WRITE_RESERVE_BYTES=0',
      '-e', 'NODE_ENV=production',
      IMAGE, 'node', '/work/driver.cjs',
    ],
    { timeoutMs: 180000 },
  );
  await docker(['rm', '-f', 'sbx-enospc']);

  const parsed = r.out
    .split('\n')
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(c => c && typeof c.case === 'string');
  if (!parsed.length) throw new Error(`the driver produced no results (exit ${r.code}): ${(r.err || r.out).slice(-1500)}`);

  const results = parsed.map(c => ({ ...c, pass: c.ok === true, summary: summarise(c) }));
  const missing = ['A.', 'B.', 'C.', 'D.'].filter(p => !results.some(c => c.case.startsWith(p)));
  if (missing.length) results.push({ case: `missing ${missing.join(',')}`, ok: false, pass: false, detail: 'the driver did not report these cases', summary: 'the driver did not report these cases' });
  const pass = results.every(c => c.pass) && r.code === 0;

  const stamp = new Date().toISOString().replaceAll(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const dir = path.join(env.reportsDir, `${stamp}-enospc`);
  fs.mkdirSync(dir, { recursive: true });
  const control = results.find(isControl);
  if (control && typeof control.detail === 'object') say(control.detail.text);
  process.stdout.write(`\n${table(results)}\n\n`);
  fs.writeFileSync(path.join(dir, 'report.md'), markdown(stamp, results, pass, { stderr: r.err }));
  writeJson(path.join(dir, 'report.json'), { stamp, image: IMAGE, pass, exitCode: r.code, results, driverStderr: r.err });
  writeJunit(dir, {
    suite: 'conductor-sandbox enospc',
    classname: 'sandbox.enospc',
    startedAt,
    cases: [
      ...results.map(c => ({
        name: c.case,
        failure: c.pass ? undefined : { type: 'CaseFailed', message: c.summary, text: `${c.summary}\n${JSON.stringify(c.detail, null, 2)}` },
        out: isControl(c) && c.pass ? `${c.summary} (inverted: bug reproduced)` : undefined,
      })),
      ...(r.code === 0 ? [] : [{ name: 'driver exit code', failure: { type: 'DriverFailed', message: `driver exited ${r.code}`, text: r.err } }]),
    ],
  });
  say(`${pass ? 'PASS' : 'FAIL'}: report in ${dir}`);
  if (!pass) process.exitCode = 1;
};
