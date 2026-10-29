import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { COMPOSE, makeComposeSandbox } from '../../../testing/composeSandbox';
import {
  getBackupDir,
  getLastGoodPath,
  readLastGood,
  refreshLastGood,
  refreshLastGoodFrom,
} from './composeBackup';
import writeComposeFile from '../writeComposeFile/writeComposeFile';

let sandbox = makeComposeSandbox();
afterEach(() => sandbox.restore());

describe('compose last-good backup', () => {
  it('lives where CONDUCTOR_COMPOSE_BACKUP_DIR says', async () => {
    sandbox = makeComposeSandbox();
    assert.equal(await getBackupDir(), join(sandbox.dir, '.conductor'));
    assert.equal(
      await getLastGoodPath(),
      join(sandbox.dir, '.conductor', 'docker-compose.last-good.yml'),
    );
  });

  it('defaults to a .conductor folder next to the compose file', async () => {
    sandbox = makeComposeSandbox();
    delete process.env.CONDUCTOR_COMPOSE_BACKUP_DIR;
    // no mounted folders on a dev machine; in the container the root-folder
    // mount (or /opt/gluesync/data) is used before this
    const dir = await getBackupDir();
    assert.ok(
      dir === join(sandbox.dir, '.conductor') ||
        dir.endsWith(join('root-folder', '.conductor')) ||
        dir.endsWith(join('gluesync', 'data', '.conductor')),
      dir,
    );
  });

  it('keeps a valid compose and refuses anything else', async () => {
    sandbox = makeComposeSandbox();
    await refreshLastGood(COMPOSE);
    assert.equal(sandbox.read(sandbox.lastGood), COMPOSE);
    assert.equal(await readLastGood(), COMPOSE);

    await assert.rejects(refreshLastGood(''), /empty/);
    await assert.rejects(refreshLastGood('services: {}\n'));
    assert.equal(sandbox.read(sandbox.lastGood), COMPOSE);
  });

  it('reads nothing back from a missing or invalid last-good copy', async () => {
    sandbox = makeComposeSandbox();
    assert.equal(await readLastGood(), null);
    sandbox.setLastGood('');
    assert.equal(await readLastGood(), null);
  });

  it('is refreshed after every compose write, with exactly what was written', async () => {
    sandbox = makeComposeSandbox();
    sandbox.setCompose(COMPOSE);
    const next = COMPOSE.replace('0.13.1', '0.13.2');
    await writeComposeFile(
      { services: { a: { image: 'x:1' } } },
      sandbox.compose,
    );
    assert.equal(sandbox.read(sandbox.lastGood), sandbox.read(sandbox.compose));
    assert.notEqual(next, COMPOSE);
  });

  it('is not refreshed by writes to other files', async () => {
    sandbox = makeComposeSandbox();
    await writeComposeFile(
      { services: { a: { image: 'x:1' } } },
      join(sandbox.dir, 'compose.generated.yml'),
    );
    assert.equal(existsSync(sandbox.lastGood), false);
  });

  it('does not fail the write when the backup cannot be written', async () => {
    sandbox = makeComposeSandbox();
    // a file where the backup folder should be
    process.env.CONDUCTOR_COMPOSE_BACKUP_DIR = join(sandbox.dir, 'blocked');
    writeFileSync(process.env.CONDUCTOR_COMPOSE_BACKUP_DIR, 'x');
    await writeComposeFile(
      { services: { a: { image: 'x:1' } } },
      sandbox.compose,
    );
    assert.match(sandbox.read(sandbox.compose), /image: x:1/);
    await refreshLastGoodFrom(sandbox.compose); // logs, does not throw
  });

  it('does not rewrite an unchanged backup', async () => {
    sandbox = makeComposeSandbox();
    sandbox.setLastGood(COMPOSE);
    mkdirSync(join(sandbox.dir, '.conductor'), { recursive: true });
    await refreshLastGood(COMPOSE);
    assert.deepEqual(readdirSync(join(sandbox.dir, '.conductor')), [
      'docker-compose.last-good.yml',
    ]);
  });
});
