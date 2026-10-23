/* eslint-disable functional/immutable-data -- records what the stubs were asked */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { after, describe, it } from 'node:test';

import fakeSwarmDocker, {
  buildService,
} from '../../../testing/fakeSwarmDocker';
import loadWithStubs from '../../../testing/loadWithStubs';
import { ExportSwarmServiceLogs } from './exportSwarmServiceLogs.model';

const asked: Array<readonly [string, number, number | undefined]> = [];

const exportSwarmServiceLogs = loadWithStubs<{
  default: ExportSwarmServiceLogs;
}>(path.resolve(__dirname, './exportSwarmServiceLogs'), {
  [path.resolve(__dirname, '../serviceLogs/serviceLogs')]: {
    default: async (name: string, sinceHours: number, tail?: number) => {
      asked.push([name, sinceHours, tail]);

      if (name === 'gs_broken') {
        throw new Error('docker service logs gs_broken failed (exit 1)');
      }

      return `2026-10-23T10:00:00Z ${name}.1.abc | hello\n`;
    },
  },
}).default;

const dirs: string[] = [];

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-logs-'));
  dirs.push(dir);

  return join(dir, 'container-logs');
};

after(async () => {
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
});

describe('exportSwarmServiceLogs', () => {
  it('writes one file per service of the stack', async () => {
    const { docker } = fakeSwarmDocker({
      services: [
        buildService('grafana', { image: 'molo17/grafana:13.0.2' }),
        buildService('gluesync-core-hub'),
      ],
    });
    const outputDirectory = await tempDir();

    const files = await exportSwarmServiceLogs(docker, 'gs', {
      outputDirectory,
      sinceHours: 120,
      tailLines: 5000,
    });

    assert.deepEqual((await readdir(outputDirectory)).sort(), [
      'service-gs_gluesync-core-hub.log',
      'service-gs_grafana.log',
    ]);
    assert.deepEqual(files.map(file => path.basename(file)).sort(), [
      'service-gs_gluesync-core-hub.log',
      'service-gs_grafana.log',
    ]);

    const grafana = await readFile(
      join(outputDirectory, 'service-gs_grafana.log'),
      'utf8',
    );

    assert.match(grafana, /^Service Logs for: gs_grafana\n/);
    assert.match(grafana, /Image: molo17\/grafana:13\.0\.2\n/);
    assert.match(grafana, /Since: last 120 hours\n/);
    assert.match(grafana, /Tail lines: 5000\n/);
    assert.match(grafana, /gs_grafana\.1\.abc \| hello\n$/);
  });

  it('asks the logs of the full service name, with the window and tail', async () => {
    asked.length = 0;
    const { docker } = fakeSwarmDocker({
      services: [buildService('grafana')],
    });

    await exportSwarmServiceLogs(docker, 'gs', {
      outputDirectory: await tempDir(),
      sinceHours: 24,
      tailLines: 100,
    });

    assert.deepEqual(asked, [['gs_grafana', 24, 100]]);
  });

  it('reads all lines without a positive tail', async () => {
    asked.length = 0;
    const { docker } = fakeSwarmDocker({
      services: [buildService('grafana')],
    });
    const outputDirectory = await tempDir();

    await exportSwarmServiceLogs(docker, 'gs', {
      outputDirectory,
      sinceHours: 24,
      tailLines: 0,
    });

    assert.deepEqual(asked, [['gs_grafana', 24, undefined]]);
    assert.match(
      await readFile(join(outputDirectory, 'service-gs_grafana.log'), 'utf8'),
      /Tail lines: all\n/,
    );
  });

  it('keeps a file with the reason for a service whose logs fail', async () => {
    const { docker } = fakeSwarmDocker({
      services: [buildService('broken'), buildService('grafana')],
    });
    const outputDirectory = await tempDir();

    const files = await exportSwarmServiceLogs(docker, 'gs', {
      outputDirectory,
      sinceHours: 24,
    });

    assert.equal(files.length, 2);
    assert.match(
      await readFile(join(outputDirectory, 'service-gs_broken.log'), 'utf8'),
      /\[collect-logs\] docker service logs failed: docker service logs gs_broken failed \(exit 1\)\n$/,
    );
    assert.match(
      await readFile(join(outputDirectory, 'service-gs_grafana.log'), 'utf8'),
      /hello\n$/,
    );
  });

  it('writes nothing for a stack without services', async () => {
    const { docker } = fakeSwarmDocker();
    const outputDirectory = await tempDir();

    assert.deepEqual(
      await exportSwarmServiceLogs(docker, 'gs', {
        outputDirectory,
        sinceHours: 24,
      }),
      [],
    );
    assert.deepEqual(await readdir(outputDirectory), []);
  });
});
