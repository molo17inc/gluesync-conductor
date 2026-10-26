import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import loadWithStubs from '../../../testing/loadWithStubs';
import type { StackDeploy } from './stackDeploy.model';

type Setup = Readonly<{
  exitCode?: number;
  output?: string;
  files?: Record<string, string | Error>;
}>;

const load = ({ exitCode = 0, output = 'ok\n', files = {} }: Setup = {}) => {
  const runs: Array<{ args: string[]; options: any }> = [];
  const reads: string[] = [];
  const subject = loadWithStubs<{ default: StackDeploy }>(
    path.resolve(__dirname, './stackDeploy'),
    {
      [path.resolve(__dirname, '../runDockerCli/runDockerCli')]: {
        default: async (args: string[], options: any) => {
          runs.push({ args, options });
          return { exitCode, output };
        },
      },
      'node:fs/promises': {
        readFile: async (file: string) => {
          reads.push(file);
          const content = files[file];
          if (content === undefined) {
            throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
          }
          if (content instanceof Error) {
            throw content;
          }
          return content;
        },
      },
    },
  );

  return { stackDeploy: subject.default, runs, reads };
};

describe('stackDeploy', () => {
  it('deploys the stack file detached, resolving images', async () => {
    const { stackDeploy, runs } = load({ output: 'Creating service gs_hub\n' });

    const output = await stackDeploy('gs', '/kit/docker-stack.yml');

    assert.equal(output, 'Creating service gs_hub\n');
    assert.deepEqual(runs[0].args, [
      'stack',
      'deploy',
      '--detach=true',
      '--resolve-image',
      'always',
      '-c',
      '/kit/docker-stack.yml',
      'gs',
    ]);
  });

  it('runs from the folder of the stack file', async () => {
    const { stackDeploy, runs } = load();

    await stackDeploy('gs', '/opt/gluesync-conductor/root-folder/stack.yml');

    assert.equal(runs[0].options.cwd, '/opt/gluesync-conductor/root-folder');
  });

  it('puts the .env in the environment of the CLI, over the process env', async () => {
    process.env.SWARM_TEST_SHARED = 'from-process';
    process.env.SWARM_TEST_ONLY_PROCESS = 'process';
    try {
      const { stackDeploy, runs, reads } = load({
        files: {
          '/kit/.env':
            '# kit\nCORE_HUB_TAG="2.3.0"\nSWARM_TEST_SHARED=from-env\n',
        },
      });

      await stackDeploy('gs', '/kit/stack.yml', '/kit/.env');

      const { env } = runs[0].options;

      assert.deepEqual(reads, ['/kit/.env']);
      assert.equal(env.CORE_HUB_TAG, '2.3.0');
      assert.equal(env.SWARM_TEST_SHARED, 'from-env');
      assert.equal(env.SWARM_TEST_ONLY_PROCESS, 'process');
    } finally {
      delete process.env.SWARM_TEST_SHARED;
      delete process.env.SWARM_TEST_ONLY_PROCESS;
    }
  });

  it('reads no .env when none is given', async () => {
    const { stackDeploy, reads, runs } = load();

    await stackDeploy('gs', '/kit/stack.yml');

    assert.deepEqual(reads, []);
    assert.equal(runs.length, 1);
  });

  it('deploys without variables when the .env file does not exist', async () => {
    const { stackDeploy, runs } = load();

    await stackDeploy('gs', '/kit/stack.yml', '/kit/.env');

    assert.equal(runs.length, 1);
  });

  it('does not deploy when the .env cannot be read', async () => {
    const { stackDeploy, runs } = load({
      files: {
        '/kit/.env': Object.assign(new Error('EACCES'), { code: 'EACCES' }),
      },
    });

    await assert.rejects(
      stackDeploy('gs', '/kit/stack.yml', '/kit/.env'),
      /EACCES/,
    );
    assert.equal(runs.length, 0);
  });

  it('rejects with what the CLI said when it fails', async () => {
    const { stackDeploy } = load({
      exitCode: 1,
      output: 'Error response from daemon: This node is not a swarm manager\n',
    });

    await assert.rejects(
      stackDeploy('gs', '/kit/stack.yml'),
      /docker stack deploy gs failed \(exit 1\): Error response from daemon: This node is not a swarm manager$/,
    );
  });
});
