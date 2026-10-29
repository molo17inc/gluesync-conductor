import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import loadWithStubs from '../../../testing/loadWithStubs';
import type { ServiceLogs } from './serviceLogs.model';

const load = (result = { exitCode: 0, output: 'line\n' }) => {
  const runs: Array<{ args: string[]; options: any }> = [];
  const subject = loadWithStubs<{ default: ServiceLogs }>(
    path.resolve(__dirname, './serviceLogs'),
    {
      [path.resolve(__dirname, '../runDockerCli/runDockerCli')]: {
        default: async (args: string[], options: any) => {
          runs.push({ args, options });
          return result;
        },
      },
    },
  );

  return { serviceLogs: subject.default, runs };
};

describe('serviceLogs', () => {
  it('asks for the timestamped, untruncated logs of the last hours', async () => {
    const { serviceLogs, runs } = load({
      exitCode: 0,
      output: '2026-10-23T10:00:00Z gs_hub.1.x@n1 | started\n',
    });

    const logs = await serviceLogs('gs_core-hub', 24);

    assert.equal(logs, '2026-10-23T10:00:00Z gs_hub.1.x@n1 | started\n');
    assert.deepEqual(runs[0].args, [
      'service',
      'logs',
      '--no-trunc',
      '--timestamps',
      '--since',
      '24h',
      'gs_core-hub',
    ]);
  });

  it('limits the lines per task with tail', async () => {
    const { serviceLogs, runs } = load();

    await serviceLogs('gs_core-hub', 2, 500);

    assert.deepEqual(runs[0].args, [
      'service',
      'logs',
      '--no-trunc',
      '--timestamps',
      '--since',
      '2h',
      '--tail',
      '500',
      'gs_core-hub',
    ]);
  });

  it('rejects with what the CLI said when it fails', async () => {
    const { serviceLogs } = load({
      exitCode: 1,
      output: 'Error: No such service: gs_ghost\n',
    });

    await assert.rejects(
      serviceLogs('gs_ghost', 1),
      /docker service logs gs_ghost failed \(exit 1\): Error: No such service: gs_ghost$/,
    );
  });
});
