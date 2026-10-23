import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { parse } from 'yaml';

import {
  COMPOSE as KIT,
  CORRUPT_SHAPES,
  makeComposeSandbox,
} from '../../../testing/composeSandbox';
import { ComposeFileCorruptError } from '../../composeFile/ensureValidCompose/composeFile.errors';
import { UnsafeWriteError } from '../safeWriteFile/safeWriteFile.errors';
import writeYmlFile from './writeYmlFile';

// yarn sets PROJECT_CWD, which getRootPath would prefix to the absolute paths below.
Reflect.deleteProperty(process.env, 'PROJECT_CWD');

const COMPOSE = `# Welcome to the kit: keep me
name: gluesync

services:
  grafana:
    # customer note: keep the setting below
    image: molo17/grafana:12.3.0
    labels:
      - customer.note=costs $$5 per month
    environment:
      - CUSTOMER_SETTING=keep-me
  portainer:
    image: molo17/portainer:2.33.6
    command:
      - --admin-password
      - $$2y$$05$$abc
`;

const fileWith = (content: string): string => {
  const file = join(mkdtempSync(join(tmpdir(), 'yml-')), 'docker-compose.yml');
  writeFileSync(file, content);
  return file;
};

describe('writeYmlFile', () => {
  it('changes only what changed and keeps comments and $$ escapes', async () => {
    const file = fileWith(COMPOSE);
    const parsed = parse(COMPOSE);
    const json = {
      ...parsed,
      services: {
        ...parsed.services,
        grafana: { ...parsed.services.grafana, image: 'molo17/grafana:12.3.1' },
      },
    };

    await writeYmlFile(json, file);

    const out = readFileSync(file, 'utf8');
    assert.match(out, /# Welcome to the kit: keep me/);
    assert.match(out, /# customer note: keep the setting below/);
    assert.match(out, /image: molo17\/grafana:12\.3\.1/);
    assert.match(out, /customer\.note=costs \$\$5 per month/);
    assert.match(out, /\$\$2y\$\$05\$\$abc/);
    assert.deepEqual(parse(out), json);
  });

  it('removes services and keys that are gone or undefined', async () => {
    const file = fileWith(COMPOSE);
    const parsed = parse(COMPOSE);
    const json = {
      ...parsed,
      services: {
        grafana: { ...parsed.services.grafana, environment: undefined },
      },
    };

    await writeYmlFile(json, file);

    const out = parse(readFileSync(file, 'utf8'));
    assert.equal(out.services.portainer, undefined);
    assert.equal('environment' in out.services.grafana, false);
    assert.equal(out.services.grafana.image, 'molo17/grafana:12.3.0');
  });

  it('adds new services', async () => {
    const file = fileWith(COMPOSE);
    const parsed = parse(COMPOSE);
    const json = {
      ...parsed,
      services: {
        ...parsed.services,
        agent: { image: 'molo17/gluesync-mssql-cdc:2.3.0.0' },
      },
    };

    await writeYmlFile(json, file);

    assert.equal(
      parse(readFileSync(file, 'utf8')).services.agent.image,
      'molo17/gluesync-mssql-cdc:2.3.0.0',
    );
  });

  it('writes a new file from scratch', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'yml-')), 'new.yml');
    await writeYmlFile({ services: { a: { image: 'x:1' } } }, file);
    assert.deepEqual(parse(readFileSync(file, 'utf8')), {
      services: { a: { image: 'x:1' } },
    });
  });
});

describe('writeYmlFile safety', () => {
  let sandbox = makeComposeSandbox();
  afterEach(() => sandbox.restore());

  const kit = (): Record<string, any> => parse(KIT);

  it('refuses a compose without services and leaves the file as it is', async () => {
    sandbox = makeComposeSandbox();
    sandbox.setCompose(KIT);
    await assert.rejects(
      writeYmlFile({ name: 'gluesync', services: {} }, sandbox.compose),
      UnsafeWriteError,
    );
    await assert.rejects(
      writeYmlFile({ name: 'gluesync' }, sandbox.compose),
      UnsafeWriteError,
    );
    assert.equal(sandbox.read(sandbox.compose), KIT);
  });

  it('refuses to write a new compose file without services either', async () => {
    sandbox = makeComposeSandbox();
    await assert.rejects(writeYmlFile({}, sandbox.compose), UnsafeWriteError);
  });

  CORRUPT_SHAPES.forEach(([name, text]) => {
    it(`does not build a compose from scratch over ${name}`, async () => {
      sandbox = makeComposeSandbox();
      sandbox.setCompose(text);
      await assert.rejects(
        writeYmlFile({ services: { a: { image: 'x:1' } } }, sandbox.compose),
        ComposeFileCorruptError,
      );
      assert.equal(sandbox.read(sandbox.compose), text);
    });

    it(`restores ${name} from the last-good copy before merging into it`, async () => {
      sandbox = makeComposeSandbox();
      sandbox.setLastGood(KIT);
      sandbox.setCompose(text);
      const json = kit();
      json.services['gluesync-conductor'].image =
        'molo17/gluesync-conductor:0.13.2';

      await writeYmlFile(json, sandbox.compose);

      const out = sandbox.read(sandbox.compose);
      assert.match(out, /# kit header/);
      assert.deepEqual(parse(out), json);
    });
  });

  it('overwrites a damaged file that is not the compose file', async () => {
    sandbox = makeComposeSandbox();
    const generated = join(sandbox.dir, 'compose.generated.yml');
    writeFileSync(generated, '');
    await writeYmlFile(kit(), generated);
    assert.deepEqual(parse(readFileSync(generated, 'utf8')), kit());
  });

  it('leaves no temp files next to the compose file', async () => {
    sandbox = makeComposeSandbox();
    sandbox.setCompose(KIT);
    await writeYmlFile(kit(), sandbox.compose);
    assert.deepEqual(
      readdirSync(sandbox.dir).filter(f => f.endsWith('.tmp')),
      [],
    );
  });
});
