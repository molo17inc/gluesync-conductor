import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ComposeFileCorruptError } from '../composeFile/ensureValidCompose/composeFile.errors';
import { DiskFullError } from '../file/safeWriteFile/safeWriteFile.errors';
import describeFailure from './describeFailure';

describe('describeFailure', () => {
  it('reads docker-compose rejections', () => {
    assert.equal(
      describeFailure({ exitCode: 1, err: 'no such service: x\n', out: '' }),
      'no such service: x',
    );
  });

  it('reads Error objects, which used to give an empty message', () => {
    assert.equal(
      describeFailure(new Error('grafana is unhealthy')),
      'grafana is unhealthy',
    );
  });

  it('falls back to out, strings and JSON', () => {
    assert.equal(describeFailure({ err: '', out: 'pulled' }), 'pulled');
    assert.equal(describeFailure('plain'), 'plain');
    assert.equal(describeFailure({ code: 7 }), '{"code":7}');
    assert.equal(describeFailure(undefined), 'unknown error');
  });
});

describe('describeFailure disk problems', () => {
  const withCode = (message: string, code: string): Error =>
    Object.assign(new Error(message), { code });

  it('names a full disk for ENOSPC, EDQUOT and DiskFullError', () => {
    assert.match(
      describeFailure(withCode('write ENOSPC', 'ENOSPC')),
      /^not enough free disk space.*write ENOSPC/,
    );
    assert.match(
      describeFailure(withCode('quota', 'EDQUOT')),
      /not enough free disk space/,
    );
    const full = new DiskFullError('/srv/docker-compose.yml', 100, 10);
    assert.equal(describeFailure(full), full.message);
    assert.match(describeFailure(full), /not enough free disk space/);
  });

  it('names a full disk when docker reports it as text', () => {
    assert.match(
      describeFailure({
        exitCode: 1,
        err: 'failed to extract layer: no space left on device',
      }),
      /^not enough free disk space: failed to extract layer/,
    );
  });

  it('names a read-only file system', () => {
    assert.match(
      describeFailure(withCode("EROFS: open 'x'", 'EROFS')),
      /read-only file system/,
    );
  });

  it('keeps the message of a corrupt compose file', () => {
    assert.match(
      describeFailure(
        new ComposeFileCorruptError('/srv/dc.yml', 'the file is empty'),
      ),
      /docker-compose\.yml is empty or corrupt/,
    );
  });
});
