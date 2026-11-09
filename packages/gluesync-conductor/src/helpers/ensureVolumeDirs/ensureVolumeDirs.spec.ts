/* eslint-disable no-template-curly-in-string -- compose interpolations are plain strings in these specs */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import loadWithStubs from '../../testing/loadWithStubs';

const here = (p: string): string => path.resolve(__dirname, p);

type Volumes = ReadonlyArray<unknown>;

const load = (volumes: Volumes | Error) =>
  loadWithStubs<{ default: typeof import('./ensureVolumeDirs').default }>(
    here('./ensureVolumeDirs'),
    {
      [here('../composeFile/readComposeFile/readComposeFile')]: {
        readComposeFile: async () => {
          if (volumes instanceof Error) {
            throw volumes;
          }
          return { services: { 'gs-agent-1': { image: 'x', volumes } } };
        },
      },
    },
  ).default;

const originalWindows = process.env.IS_WINDOWS;
afterEach(() => {
  if (originalWindows === undefined) {
    delete process.env.IS_WINDOWS;
  } else {
    process.env.IS_WINDOWS = originalWindows;
  }
});

const newKit = (): string => {
  delete process.env.IS_WINDOWS;
  return mkdtempSync(path.join(tmpdir(), 'ensure-volumes-'));
};

describe('ensureVolumeDirs on Linux', () => {
  it('creates the relative bind folders of the service under the kit directory', async () => {
    const rootFolder = newKit();
    const ensure = load([
      './logs/gs-agent-1:/opt/gluesync/logs:z',
      './data/gs-agent-1:/opt/gluesync/data:z',
      './shared:/opt/gluesync/shared:ro',
    ]);

    await ensure('gs-agent-1', { rootFolder });

    assert.ok(statSync(path.join(rootFolder, 'logs/gs-agent-1')).isDirectory());
    assert.ok(statSync(path.join(rootFolder, 'data/gs-agent-1')).isDirectory());
    assert.ok(statSync(path.join(rootFolder, 'shared')).isDirectory());
  });

  it('keeps what exists, and makes the folder of a long-syntax bind', async () => {
    const rootFolder = newKit();
    mkdirSync(path.join(rootFolder, 'logs/gs-agent-1'), { recursive: true });
    const ensure = load([
      './logs/gs-agent-1:/opt/gluesync/logs',
      { type: 'bind', source: './more/stuff', target: '/stuff' },
      { type: 'volume', source: 'named', target: '/n' },
    ]);

    await ensure('gs-agent-1', { rootFolder });

    assert.ok(existsSync(path.join(rootFolder, 'more/stuff')));
    assert.equal(existsSync(path.join(rootFolder, 'named')), false);
  });

  it('never invents a folder for a file, a named volume, an absolute path or a variable', async () => {
    const rootFolder = newKit();
    const ensure = load([
      './shared/gs-license.dat:/opt/gluesync/data/gs-license.dat:ro',
      './logback.xml:/x/logback.xml:ro',
      './.env:/x/.env',
      'pgdata:/var/lib/postgresql',
      '/srv/absolute:/abs',
      '${CONFIG}/x:/y',
      './../outside:/o',
    ]);

    await ensure('gs-agent-1', { rootFolder });

    assert.deepEqual(
      existsSync(path.join(rootFolder, 'shared')) ||
        existsSync(path.join(rootFolder, 'logback.xml')) ||
        existsSync(path.join(rootFolder, '.env')) ||
        existsSync(path.join(rootFolder, 'pgdata')) ||
        existsSync(path.join(rootFolder, '..', 'outside')),
      false,
    );
  });

  it('does nothing without the kit mounted (a dev run)', async () => {
    const parent = newKit();
    const rootFolder = path.join(parent, 'not-mounted');
    const ensure = load(['./logs/gs-agent-1:/opt/gluesync/logs:z']);

    await ensure('gs-agent-1', { rootFolder });

    assert.equal(existsSync(rootFolder), false);
  });

  it('never throws: a compose file it cannot read is left to compose', async () => {
    const rootFolder = newKit();

    await assert.doesNotReject(
      load(new Error('corrupt'))('gs-agent-1', { rootFolder }),
    );
    await assert.doesNotReject(load([])('unknown-service', { rootFolder }));
  });
});

describe('ensureVolumeDirs on Windows', () => {
  it('keeps making a logs and a data folder per service under root-folder', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'ensure-windows-'));
    process.env.IS_WINDOWS = 'true';
    const saved = process.env.PROJECT_CWD;
    process.env.PROJECT_CWD = cwd;

    try {
      await load([])('grafana');

      assert.ok(existsSync(path.join(cwd, 'root-folder/logs/grafana')));
      assert.ok(existsSync(path.join(cwd, 'root-folder/data/grafana')));
    } finally {
      if (saved === undefined) {
        delete process.env.PROJECT_CWD;
      } else {
        process.env.PROJECT_CWD = saved;
      }
    }
  });
});
