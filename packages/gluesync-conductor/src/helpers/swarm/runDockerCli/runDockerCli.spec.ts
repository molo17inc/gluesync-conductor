import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';

import loadWithStubs from '../../../testing/loadWithStubs';
import type { RunDockerCli } from './runDockerCli.model';

type Script = (child: {
  stdout: PassThrough;
  stderr: PassThrough;
  emitter: EventEmitter;
}) => void;

const load = (
  script: Script,
  resolve: () => string = () => '/usr/bin/docker',
) => {
  const spawned: Array<{ command: string; args: string[]; options: any }> = [];
  const subject = loadWithStubs<{ default: RunDockerCli }>(
    path.resolve(__dirname, './runDockerCli'),
    {
      [path.resolve(__dirname, '../resolveDockerCliPath/resolveDockerCliPath')]:
        { default: resolve },
      'node:child_process': {
        spawn: (command: string, args: string[], options: any) => {
          spawned.push({ command, args, options });
          const emitter = new EventEmitter();
          const stdout = new PassThrough();
          const stderr = new PassThrough();
          setImmediate(() => script({ stdout, stderr, emitter }));

          return Object.assign(emitter, { stdout, stderr });
        },
      },
    },
  );

  return { run: subject.default, spawned };
};

const close = (
  { stdout, stderr, emitter }: Parameters<Script>[0],
  code: number | null,
) => {
  stdout.end();
  stderr.end();
  setImmediate(() => emitter.emit('close', code));
};

describe('runDockerCli', () => {
  it('runs the docker CLI without a shell and returns its output', async () => {
    const { run, spawned } = load(child => {
      child.stdout.write('Creating service gs_core-hub\n');
      close(child, 0);
    });

    const result = await run(['stack', 'deploy', 'gs'], {
      cwd: '/kit',
      env: { A: '1' },
      timeoutMs: 5000,
    });

    assert.deepEqual(result, {
      exitCode: 0,
      output: 'Creating service gs_core-hub\n',
    });
    assert.equal(spawned[0].command, '/usr/bin/docker');
    assert.deepEqual(spawned[0].args, ['stack', 'deploy', 'gs']);
    assert.equal(spawned[0].options.shell, false);
    assert.equal(spawned[0].options.cwd, '/kit');
    assert.deepEqual(spawned[0].options.env, { A: '1' });
    assert.equal(spawned[0].options.timeout, 5000);
  });

  it('rejects when no docker CLI exists in the fixed locations', async () => {
    const { run } = load(
      () => undefined,
      () => {
        throw new Error('docker CLI not found');
      },
    );

    await assert.rejects(run(['x']), /docker CLI not found/);
  });

  it('keeps stdout and stderr in the order they were written', async () => {
    const { run } = load(child => {
      child.stdout.write('one\n');
      child.stderr.write('two\n');
      setImmediate(() => {
        child.stdout.write('three\n');
        close(child, 0);
      });
    });

    const { output } = await run(['x']);

    assert.equal(output, 'one\ntwo\nthree\n');
  });

  it('resolves with a failing exit code instead of rejecting', async () => {
    const { run } = load(child => {
      child.stderr.write('network gs_net not found\n');
      close(child, 1);
    });

    assert.deepEqual(await run(['stack', 'deploy', 'gs']), {
      exitCode: 1,
      output: 'network gs_net not found\n',
    });
  });

  it('reports a killed process (timeout) as a failure', async () => {
    const { run } = load(child => close(child, null));

    assert.equal((await run(['x'])).exitCode, 1);
  });

  it('rejects when the CLI cannot be started', async () => {
    const { run } = load(({ stdout, stderr, emitter }) => {
      stdout.destroy();
      stderr.destroy();
      emitter.emit('error', new Error('spawn docker ENOENT'));
    });

    await assert.rejects(run(['x']), /spawn docker ENOENT/);
  });

  it('does not stall on output larger than the stream buffers', async () => {
    const line = `${'x'.repeat(1023)}\n`;
    const { run } = load(child => {
      Array.from({ length: 512 }).forEach(() => child.stdout.write(line));
      close(child, 0);
    });

    const { output } = await run(['service', 'logs', 'gs_core-hub']);

    assert.equal(output.length, 512 * 1024);
  });
});
