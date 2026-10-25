/* eslint-disable functional/no-let, functional/immutable-data, functional/prefer-immutable-types */
// process.platform is overridden for the duration of each test.
import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import loadWithStubs from '../../testing/loadWithStubs';

type Detect = { default: () => boolean };

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

const setPlatform = (value: string) =>
  Object.defineProperty(process, 'platform', { value });

type Stubs = Readonly<{
  uname: string | Error;
  loader?: string | Error;
  cpuInfo?: string | Error;
}>;

const load = ({ uname, loader, cpuInfo }: Stubs) => {
  const calls: Array<{ file: string; args: ReadonlyArray<string> }> = [];
  const subject = loadWithStubs<Detect>(
    path.resolve(__dirname, './detectCpuSupportsX86_64V3'),
    {
      'node:child_process': {
        execFileSync: (file: string, args: ReadonlyArray<string>) => {
          calls.push({ file, args });
          if (uname instanceof Error) {
            throw uname;
          }
          return `${uname}\n`;
        },
        execSync: () => {
          if (loader === undefined || loader instanceof Error) {
            throw loader ?? new Error('no loader');
          }
          return loader;
        },
      },
      'node:fs': {
        readFileSync: () => {
          if (cpuInfo === undefined || cpuInfo instanceof Error) {
            throw cpuInfo ?? new Error('no cpuinfo');
          }
          return cpuInfo;
        },
      },
    },
  );

  return { detect: subject.default, calls };
};

describe('detectCpuSupportsX8664V3', () => {
  beforeEach(() => {
    mock.method(console, 'log', () => undefined);
    setPlatform('linux');
  });

  afterEach(() => {
    mock.restoreAll();
    if (realPlatform) {
      Object.defineProperty(process, 'platform', realPlatform);
    }
  });

  it('assumes support off Linux without asking uname', () => {
    setPlatform('darwin');
    const { detect, calls } = load({ uname: 'x86_64' });

    assert.equal(detect(), true);
    assert.equal(calls.length, 0);
  });

  it('reads the architecture from /bin/uname without a shell', () => {
    const { detect, calls } = load({ uname: 'aarch64' });

    assert.equal(detect(), true);
    assert.deepEqual(calls, [{ file: '/bin/uname', args: ['-m'] }]);
  });

  it('assumes support when uname fails', () => {
    const { detect } = load({ uname: new Error('ENOENT') });

    assert.equal(detect(), true);
  });

  it('trusts a loader that reports v3 as supported', () => {
    const { detect } = load({
      uname: 'x86_64',
      loader: 'x86-64-v3 (supported, searched)',
    });

    assert.equal(detect(), true);
  });

  it('trusts a loader that reports v3 as unsupported', () => {
    const { detect } = load({
      uname: 'amd64',
      loader: 'x86-64-v3 (unsupported)',
    });

    assert.equal(detect(), false);
  });

  it('falls back to /proc/cpuinfo flags when no loader answers', () => {
    const all = 'avx avx2 bmi1 bmi2 f16c fma movbe xsave abm';
    assert.equal(
      load({ uname: 'x86_64', cpuInfo: `flags : ${all}\n` }).detect(),
      true,
    );
    assert.equal(
      load({ uname: 'x86_64', cpuInfo: 'flags : avx avx2\n' }).detect(),
      false,
    );
  });

  it('assumes support when no flags can be read', () => {
    assert.equal(load({ uname: 'x86_64' }).detect(), true);
  });
});
