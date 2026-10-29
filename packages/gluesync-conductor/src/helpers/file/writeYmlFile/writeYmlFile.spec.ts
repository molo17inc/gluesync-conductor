import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';

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
      const file = fileWith(WITH_LABELS);

      await writeYmlFile(
        withLabels(['a=1', 'b=two words', 'c=3', 'd=4', 'e=5']),
        file,
      );

      assert.equal(
        readFileSync(file, 'utf8'),
        WITH_LABELS.replace(
          '      - c=3\n',
          '      - c=3\n      - d=4\n      - e=5\n',
        ),
      );
    });

    it('removes entries and gives back the original text when they are appended again', async () => {
      const file = fileWith(WITH_LABELS);
      await writeYmlFile(
        withLabels(['a=1', 'b=two words', 'c=3', 'd=4']),
        file,
      );

      await writeYmlFile(withLabels(['a=1', 'b=two words', 'c=3']), file);

      assert.equal(readFileSync(file, 'utf8'), WITH_LABELS);

      await writeYmlFile(withLabels(['a=1', 'c=3']), file);

      assert.equal(
        readFileSync(file, 'utf8'),
        WITH_LABELS.replace('      - "b=two words"\n', ''),
      );
    });

    it('writes what was asked when entries change in the middle', async () => {
      const file = fileWith(WITH_LABELS);
      const json = withLabels(['a=1', 'B=two', 'c=3', 'd=4']);

      await writeYmlFile(json, file);

      assert.deepEqual(parse(readFileSync(file, 'utf8')), json);
    });
  });
});
