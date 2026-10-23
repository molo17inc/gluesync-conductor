import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ComposeFileCorruptError } from '../helpers/composeFile/ensureValidCompose/composeFile.errors';
import { DiskFullError } from '../helpers/file/safeWriteFile/safeWriteFile.errors';
import buildLocalErrorReply from './buildLocalErrorReply';

const errno = (code: string, message: string, path?: string): Error =>
  Object.assign(new Error(message), { code, path });

describe('buildLocalErrorReply', () => {
  it('answers a refused write with 507 and the disk-full diagnosis', () => {
    const reply = buildLocalErrorReply(
      new DiskFullError('/srv/docker-compose.yml', 52428800, 1048576),
    );

    assert.equal(reply?.statusCode, 507);
    assert.equal(reply?.body.success, false);
    assert.equal(reply?.body.error, 'Not enough free disk space');
    assert.match(reply?.body.details ?? '', /not enough free disk space/);
    assert.equal(reply?.body.diagnosis.code, 'DISK_FULL');
    assert.equal(reply?.body.diagnosis.owner, 'customer');
    assert.deepEqual(reply?.body.diagnosis.params, {
      path: '/srv/docker-compose.yml',
      neededBytes: 52428800,
      availableBytes: 1048576,
    });
    assert.deepEqual(reply?.body.diagnosis.resolutionCodes, [
      'FREE_DISK_SPACE',
      'CONTACT_SUPPORT_WITH_DETAILS',
    ]);
    assert.match(
      reply?.body.diagnosis.fallback.summary ?? '',
      /50\.0 MiB needed, 1\.0 MiB available\)\. Nothing was changed/,
    );
  });

  it('leaves availableBytes out when the free space is unknown', () => {
    const reply = buildLocalErrorReply(
      new DiskFullError('/srv/docker-compose.yml', 4096),
    );

    assert.deepEqual(reply?.body.diagnosis.params, {
      path: '/srv/docker-compose.yml',
      neededBytes: 4096,
    });
  });

  it('treats a kernel ENOSPC as disk full, with the path when it has one', () => {
    const reply = buildLocalErrorReply(
      errno('ENOSPC', 'write ENOSPC', '/srv/.env'),
    );

    assert.equal(reply?.statusCode, 507);
    assert.deepEqual(reply?.body.diagnosis.params, { path: '/srv/.env' });
    assert.match(reply?.body.details ?? '', /^not enough free disk space/);
  });

  it('treats EDQUOT as disk full', () => {
    const reply = buildLocalErrorReply(errno('EDQUOT', 'write EDQUOT'));

    assert.equal(reply?.statusCode, 507);
    assert.equal(reply?.body.diagnosis.code, 'DISK_FULL');
    assert.deepEqual(reply?.body.diagnosis.params, {});
    assert.match(reply?.body.details ?? '', /not enough free disk space/);
  });

  it('answers a corrupt compose file with 500 and its diagnosis', () => {
    const reply = buildLocalErrorReply(
      new ComposeFileCorruptError(
        '/srv/docker-compose.yml',
        'the file is empty',
      ),
    );

    assert.equal(reply?.statusCode, 500);
    assert.equal(reply?.body.error, 'docker-compose.yml is empty or corrupt');
    assert.match(reply?.body.details ?? '', /empty or corrupt/);
    assert.equal(reply?.body.diagnosis.code, 'COMPOSE_FILE_CORRUPT');
    assert.equal(reply?.body.diagnosis.owner, 'local');
    assert.deepEqual(reply?.body.diagnosis.params, {
      path: '/srv/docker-compose.yml',
      problem: 'the file is empty',
    });
    assert.match(
      reply?.body.diagnosis.fallback.summary ?? '',
      /no last-good backup could restore it/,
    );
  });

  it('keeps the error title a route already used', () => {
    const reply = buildLocalErrorReply(
      new DiskFullError('/srv/docker-compose.yml', 10, 0),
      'Failed to do containers action',
    );

    assert.equal(reply?.body.error, 'Failed to do containers action');
    assert.equal(
      reply?.body.diagnosis.fallback.title,
      'Not enough free disk space',
    );
  });

  it('leaves every other failure to the caller', () => {
    assert.equal(buildLocalErrorReply(new Error('boom')), undefined);
    assert.equal(
      buildLocalErrorReply(errno('EROFS', 'read-only file system')),
      undefined,
    );
    assert.equal(buildLocalErrorReply('ENOSPC'), undefined);
    assert.equal(buildLocalErrorReply(null), undefined);
  });
});
