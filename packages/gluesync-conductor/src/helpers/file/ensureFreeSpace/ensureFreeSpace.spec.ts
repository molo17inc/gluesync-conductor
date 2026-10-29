import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { DiskFullError } from '../safeWriteFile/safeWriteFile.errors';
import ensureFreeSpace, {
  getUpdateMinFreeBytes,
  getWriteReserveBytes,
  queryFreeBytes,
} from './ensureFreeSpace';

const VARS = [
  'CONDUCTOR_UPDATE_MIN_FREE_BYTES',
  'CONDUCTOR_WRITE_RESERVE_BYTES',
];

afterEach(() => {
  VARS.forEach(name => delete process.env[name]);
});

const errno = (code: string): Error => Object.assign(new Error(code), { code });

describe('ensureFreeSpace', () => {
  it('passes when there is enough room and fails with DiskFullError when not', async () => {
    const statfs = async () => ({ bavail: 10, bsize: 100 });
    await ensureFreeSpace(['/a'], 1000, statfs);
    await assert.rejects(
      ensureFreeSpace(['/a'], 1001, statfs),
      (error: unknown) => {
        assert.ok(error instanceof DiskFullError);
        assert.equal(error.available, 1000);
        assert.equal(error.needed, 1001);
        assert.equal(error.path, '/a');
        return true;
      },
    );
  });

  it('checks every path and reports the one that is short', async () => {
    const free: Record<string, number> = { '/file': 1000, '/dir': 5 };
    const asked: string[] = [];
    const statfs = async (path: string) => {
      asked.push(path);
      return { bavail: free[path], bsize: 1 };
    };
    await assert.rejects(
      ensureFreeSpace(['/file', '/dir'], 100, statfs),
      (error: unknown) => (error as DiskFullError).path === '/dir',
    );
    assert.deepEqual(asked, ['/file', '/dir']);
  });

  it('skips the check where statfs is not supported', async () => {
    await Promise.all(
      ['ENOSYS', 'ENOTSUP', 'EINVAL'].map(code =>
        assert.doesNotReject(
          ensureFreeSpace(['/a'], 1e18, async () => {
            throw errno(code);
          }),
        ),
      ),
    );
  });

  it('lets other statfs failures through', async () => {
    await assert.rejects(
      ensureFreeSpace(['/a'], 1, async () => {
        throw errno('EIO');
      }),
      { code: 'EIO' },
    );
  });

  it('uses the directory of a file that does not exist yet', async () => {
    const asked: string[] = [];
    await ensureFreeSpace(['/srv/new.yml'], 1, async (path: string) => {
      asked.push(path);
      if (path === '/srv/new.yml') {
        throw errno('ENOENT');
      }
      return { bavail: 5, bsize: 1 };
    });
    assert.deepEqual(asked, ['/srv/new.yml', '/srv']);
  });

  it('queryFreeBytes gives undefined instead of throwing', async () => {
    assert.equal(
      await queryFreeBytes('/a', async () => {
        throw errno('EIO');
      }),
      undefined,
    );
    assert.equal(
      await queryFreeBytes('/a', async () => ({ bavail: 2, bsize: 3 })),
      6,
    );
  });
});

describe('disk space settings', () => {
  it('default to 512 MiB for an update and 1 MiB per write', () => {
    assert.equal(getUpdateMinFreeBytes(), 536870912);
    assert.equal(getWriteReserveBytes(), 1048576);
  });

  it('are read at call time and ignore bad values', () => {
    process.env.CONDUCTOR_UPDATE_MIN_FREE_BYTES = '65536';
    process.env.CONDUCTOR_WRITE_RESERVE_BYTES = '4096';
    assert.equal(getUpdateMinFreeBytes(), 65536);
    assert.equal(getWriteReserveBytes(), 4096);

    process.env.CONDUCTOR_UPDATE_MIN_FREE_BYTES = 'lots';
    process.env.CONDUCTOR_WRITE_RESERVE_BYTES = '-1';
    assert.equal(getUpdateMinFreeBytes(), 536870912);
    assert.equal(getWriteReserveBytes(), 1048576);

    process.env.CONDUCTOR_WRITE_RESERVE_BYTES = '';
    assert.equal(getWriteReserveBytes(), 1048576);
  });
});
