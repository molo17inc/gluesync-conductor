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
});
