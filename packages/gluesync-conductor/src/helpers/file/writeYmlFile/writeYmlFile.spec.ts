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

  describe('sequences of the same length', () => {
    const STACK = `services:
  app:
    image: molo17/app:1.0.0
    secrets:
      - source: a
        target: /x
        mode: 0444
      - source: b
        target: /y
        mode: 0444
`;

    const changed = async (
      change: (app: Record<string, any>) => Record<string, any>,
    ): Promise<string> => {
      const file = fileWith(STACK);
      const parsed = parse(STACK);

      await writeYmlFile(
        { services: { app: change(parsed.services.app) } },
        file,
      );

      return readFileSync(file, 'utf8');
    };

    it('keeps `mode: 0444` literal when only the image changes', async () => {
      const out = await changed(app => ({ ...app, image: 'molo17/app:1.0.1' }));

      assert.match(out, /image: molo17\/app:1\.0\.1/);
      assert.equal(out.match(/mode: 0444/g)?.length, 2);
      assert.doesNotMatch(out, /mode: 444\b/);
    });

    it('keeps the sibling secret `mode: 0444` when one target changes', async () => {
      const out = await changed(app => ({
        ...app,
        secrets: [app.secrets[0], { ...app.secrets[1], target: '/z' }],
      }));

      assert.match(out, /target: \/z/);
      assert.match(out, /target: \/x\n {8}mode: 0444/);
      assert.doesNotMatch(out, /mode: 444\b/);
    });

    it('replaces the whole sequence when the length differs', async () => {
      const out = await changed(app => ({
        ...app,
        secrets: [app.secrets[0]],
      }));

      assert.equal(parse(out).services.app.secrets.length, 1);
      assert.equal(parse(out).services.app.secrets[0].source, 'a');
    });
  });

  describe('long strings', () => {
    const RULE =
      'traefik.http.routers.chronos.rule=PathPrefix(`/chronos/`) || PathPrefix(`/chronos/api/`)';
    const LABELS = `services:
  chronos:
    image: molo17/gluesync-chronos:0.2.4
    labels:
      - "${RULE}"
`;

    it('does not fold a long string that changed in an existing file', async () => {
      const file = fileWith(LABELS);
      const parsed = parse(LABELS);
      const changedRule = RULE.replace('/chronos/api/', '/chronos/v2/');

      await writeYmlFile(
        {
          services: {
            chronos: { ...parsed.services.chronos, labels: [changedRule] },
          },
        },
        file,
      );

      const out = readFileSync(file, 'utf8');
      assert.match(
        out,
        new RegExp(
          `^ {6}- "${changedRule.replace(/[$()|`/]/g, '\\$&')}"$`,
          'm',
        ),
      );
      assert.equal(out.trimEnd().split('\n').length, 5);
      assert.equal(parse(out).services.chronos.labels[0], changedRule);
    });

    it('does not fold a long string when the file is written from scratch', async () => {
      const file = join(mkdtempSync(join(tmpdir(), 'yml-')), 'new.yml');
      const long = `${'word '.repeat(60)}end`;

      await writeYmlFile({ services: { a: { command: long } } }, file);

      const out = readFileSync(file, 'utf8');
      assert.equal(out.trimEnd().split('\n').length, 3);
      assert.equal(parse(out).services.a.command, long);
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

  describe('lists of plain values that gain or lose entries', () => {
    const WITH_LABELS = `services:
  proxy:
    image: molo17/traefik:3.7.16.3
    labels:
      # the proxy is third-party
      - a=1 # first
      - "b=two words"
      - c=3
  other:
    image: x
`;

    const withLabels = (labels: string[]) => {
      const parsed = parse(WITH_LABELS);
      return {
        ...parsed,
        services: {
          ...parsed.services,
          proxy: { ...parsed.services.proxy, labels },
        },
      };
    };

    it('appends new entries and leaves the ones that stay (comments, quoting) as they are', async () => {
      sandbox = makeComposeSandbox();
      sandbox.setCompose(WITH_LABELS);

      await writeYmlFile(
        withLabels(['a=1', 'b=two words', 'c=3', 'd=4', 'e=5']),
        sandbox.compose,
      );

      assert.equal(
        sandbox.read(sandbox.compose),
        WITH_LABELS.replace(
          '      - c=3\n',
          '      - c=3\n      - d=4\n      - e=5\n',
        ),
      );
    });

    it('removes entries and gives back the original text when they are appended again', async () => {
      sandbox = makeComposeSandbox();
      sandbox.setCompose(WITH_LABELS);
      await writeYmlFile(
        withLabels(['a=1', 'b=two words', 'c=3', 'd=4']),
        sandbox.compose,
      );

      await writeYmlFile(
        withLabels(['a=1', 'b=two words', 'c=3']),
        sandbox.compose,
      );

      assert.equal(sandbox.read(sandbox.compose), WITH_LABELS);

      await writeYmlFile(withLabels(['a=1', 'c=3']), sandbox.compose);

      assert.equal(
        sandbox.read(sandbox.compose),
        WITH_LABELS.replace('      - "b=two words"\n', ''),
      );
    });

    it('writes what was asked when entries change in the middle', async () => {
      sandbox = makeComposeSandbox();
      sandbox.setCompose(WITH_LABELS);
      const json = withLabels(['a=1', 'B=two', 'c=3', 'd=4']);

      await writeYmlFile(json, sandbox.compose);

      assert.deepEqual(parse(sandbox.read(sandbox.compose)), json);
    });
  });
});
