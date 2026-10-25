/* eslint-disable no-throw-literal -- docker-compose rejects with plain { exitCode, err, out } objects */
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import loadWithStubs from '../../../testing/loadWithStubs';
import type { RunCmd, RunCmdFn } from './createActions.model';

const here = (p: string): string => path.resolve(__dirname, p);

type Subject = { runCmd: RunCmd; toComposeError: (f: unknown) => Error };

// The real retry helper runs; only compose, Docker and the logger are replaced.
const load = () => {
  const dockerWaits: number[] = [];
  const subject = loadWithStubs<Subject>(here('./createActions'), {
    'docker-compose': {},
    [here('../../getRootPath/getRootPath')]: { default: () => '/srv/gs' },
    [here('../cleanupOrphanNetworkByName/cleanupOrphanNetworkByName')]: {
      default: async () => 'net',
    },
    [here('../../composeFile/readComposeFile/readComposeFile')]: {
      readComposeFile: async () => ({ services: {} }),
    },
    [here('../../composeFile/writeComposeFile/writeComposeFile')]: {
      default: async () => undefined,
    },
    [here('../../../utils/logger')]: {
      getLogger: () => ({ info: () => 0, warn: () => 0, error: () => 0 }),
    },
    [here('../../autoReboot/autoReboot')]: { autoReboot: async () => true },
    [here('../../ensureVolumeDirs/ensureVolumeDirs')]: {
      default: async () => undefined,
    },
    [here('../../../plugins/apiBlockerAsUpdating')]: {
      enableUpdateMode: () => 0,
    },
    [here(
      '../restartWindowsDependentServices/restartWindowsDependentServices',
    )]: { default: async () => '' },
    [here('../../verifyServiceStable/verifyServiceStable')]: {
      default: async () => undefined,
    },
    [here('../waitForDockerOutage/waitForDockerOutage')]: {
      default: async (_docker: unknown, budgetMs?: number) => {
        dockerWaits.push(budgetMs ?? -1);
      },
      dockerWaitMs: () => 60000,
    },
    [here('../../../utils/docker/getDocker')]: { getDocker: () => ({}) },
  });
  return { ...subject, dockerWaits };
};

// A compose command that fails with each of `failures` in turn, then succeeds.
const composeFailing = (failures: ReadonlyArray<unknown>) => {
  const attempts: number[] = [];
  const cmd: RunCmdFn = async () => {
    attempts.push(attempts.length);
    if (attempts.length <= failures.length) {
      throw failures[attempts.length - 1];
    }
    return { out: 'up ok', err: '', exitCode: 0 };
  };
  return { cmd, attempts };
};

const connectionLost = {
  exitCode: 1,
  out: '',
  err: 'error during connect: Get "http://%2Fvar%2Frun%2Fsandbox-sock%2Fdocker.sock/v1.51/containers/json": EOF',
};

describe('runCmd', () => {
  it('retries a Docker connection error from docker-compose, waiting for Docker in between', async () => {
    const { runCmd, dockerWaits } = load();
    const { cmd, attempts } = composeFailing([connectionLost]);
    assert.equal(await runCmd(cmd, 'grafana', 'c.yml', ['--no-deps']), 'up ok');
    assert.equal(attempts.length, 2);
    assert.equal(dockerWaits.length, 1);
  });

  it('retries the "Cannot connect to the Docker daemon" message too', async () => {
    const { runCmd } = load();
    const { cmd, attempts } = composeFailing([
      {
        exitCode: 1,
        out: '',
        err: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
      },
    ]);
    await runCmd(cmd, 'grafana', 'c.yml');
    assert.equal(attempts.length, 2);
  });

  it('does not retry a real compose error', async () => {
    const { runCmd, dockerWaits } = load();
    const real = {
      exitCode: 1,
      out: '',
      err: 'Bind for 0.0.0.0:443 failed: port is already allocated',
    };
    const { cmd, attempts } = composeFailing([real]);
    await assert.rejects(
      runCmd(cmd, 'reverse-proxy', 'c.yml'),
      (error: Error & { exitCode?: number }) => {
        assert.equal(error.message, real.err);
        assert.equal(error.exitCode, 1);
        return true;
      },
    );
    assert.equal(attempts.length, 1);
    assert.equal(dockerWaits.length, 0);
  });

  it('gives up with the compose message after the last attempt', async () => {
    const { runCmd } = load();
    const { cmd, attempts } = composeFailing([connectionLost, connectionLost]);
    await assert.rejects(
      runCmd(cmd, 'grafana', 'c.yml', [], 1),
      /error during connect/,
    );
    assert.equal(attempts.length, 1);
  });

  it('turns a compose result with a failing exit code into an error too', async () => {
    const { runCmd } = load();
    const cmd: RunCmdFn = async () => ({
      out: '',
      err: 'boom',
      exitCode: 2,
    });
    await assert.rejects(runCmd(cmd, 'grafana', 'c.yml'), /boom/);
  });
});

describe('toComposeError', () => {
  it('uses the compose error output, then its standard output', () => {
    const { toComposeError } = load();
    assert.equal(
      toComposeError({ exitCode: 1, out: 'from out', err: ' from err ' })
        .message,
      'from err',
    );
    assert.equal(
      toComposeError({ exitCode: 1, out: 'from out', err: '' }).message,
      'from out',
    );
    assert.equal(
      toComposeError({ exitCode: 1 }).message,
      'docker-compose failed',
    );
  });

  it('keeps an Error as it is', () => {
    const { toComposeError } = load();
    const error = new Error('already one');
    assert.equal(toComposeError(error), error);
  });
});
