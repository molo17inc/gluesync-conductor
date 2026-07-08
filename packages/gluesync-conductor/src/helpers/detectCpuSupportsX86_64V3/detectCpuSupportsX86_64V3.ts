import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const REQUIRED_FLAGS = [
  'avx',
  'avx2',
  'bmi1',
  'bmi2',
  'f16c',
  'fma',
  'movbe',
  'xsave',
  'abm',
];

const detectCpuSupportsX8664V3 = (): boolean => {
  console.log('[CPU] Starting x86-64-v3 detection…');

  if (process.platform !== 'linux') {
    console.log('[CPU] Non-Linux platform → assume supported.');
    return true;
  }

  const arch = (() => {
    try {
      const value = execSync('uname -m', { encoding: 'utf8' }).trim();
      console.log(`[CPU] uname -m → ${value}`);
      return value;
    } catch (err) {
      console.log('[CPU] Failed to read uname -m:', err);
      return '';
    }
  })();

  if (arch !== 'x86_64' && arch !== 'amd64') {
    console.log('[CPU] Non-x86_64 architecture → assume supported.');
    return true;
  }

  const candidates = [
    '/lib64/ld-linux-x86-64.so.2',
    '/lib/ld-linux-x86-64.so.2',
    '/usr/lib64/ld-linux-x86-64.so.2',
  ];

  const loaderResult = candidates
    .map(ldSo => {
      try {
        console.log(`[CPU] Checking loader: ${ldSo}`);
        const out = execSync(`${ldSo} --help`, { encoding: 'utf8' });
        const hasV3 = out.includes('x86-64-v3');
        const supported = out.includes('x86-64-v3 (supported');
        console.log(
          `[CPU] Loader ${ldSo} reports v3: ${hasV3}, supported: ${supported}`,
        );
        return { hasV3, supported };
      } catch (err) {
        console.log(`[CPU] Loader ${ldSo} not usable:`, err);
        return { hasV3: false, supported: false };
      }
    })
    .find(r => r.hasV3);

  if (loaderResult) {
    return loaderResult.supported;
  }

  const flagsLine = (() => {
    try {
      console.log('[CPU] Reading /proc/cpuinfo…');
      const cpuInfo = readFileSync('/proc/cpuinfo', 'utf8');
      const line = cpuInfo
        .split('\n')
        .find(l => l.toLowerCase().startsWith('flags'));
      const value = line ? (line.split(':')[1] ?? '') : '';
      console.log(`[CPU] Flags line: ${value}`);
      return value;
    } catch (err) {
      console.log('[CPU] Failed to read /proc/cpuinfo:', err);
      return '';
    }
  })();

  if (!flagsLine) {
    console.log('[CPU] No flags found → assume supported.');
    return true;
  }

  const flags = new Set(flagsLine.trim().split(/\s+/));
  console.log('[CPU] Parsed flags:', Array.from(flags).join(', '));

  const missingFlag = REQUIRED_FLAGS.find(flag => !flags.has(flag));

  if (missingFlag) {
    console.log(
      `[CPU] Missing required flag: ${missingFlag} → CPU does NOT support x86-64-v3`,
    );
    return false;
  }

  console.log('[CPU] All required flags present → CPU supports x86-64-v3');
  return true;
};

export default detectCpuSupportsX8664V3;
