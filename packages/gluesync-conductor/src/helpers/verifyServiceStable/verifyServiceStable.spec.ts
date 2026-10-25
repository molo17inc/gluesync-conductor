import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type Docker from 'dockerode';

import loadWithStubs from '../../testing/loadWithStubs';
import verifyServiceStable from './verifyServiceStable';
import type { VerifyServiceStable } from './verifyServiceStable.model';

type State = {
  Status: string;
  Restarting?: boolean;
  ExitCode: number;
  Health?: { Status: string };
};

// Each poll returns the next observation (the last one repeats).
const dockerSeeing = (
  observations: ReadonlyArray<{ state: State; restarts: number }>,
): Docker => {
  const cursor = new Map<string, number>([['i', 0]]);
  return {
    listContainers: async () => [{ Id: 'c1', State: 'running' }],
    getContainer: () => ({
      inspect: async () => {
        const i = cursor.get('i') ?? 0;
        const o = observations[Math.min(i, observations.length - 1)];
        cursor.set('i', i + 1);
        return { State: o.state, RestartCount: o.restarts };
      },
    }),
  } as unknown as Docker;
};

const running: State = { Status: 'running', ExitCode: 0 };
const fast = { windowMs: 30, maxWaitMs: 500, pollMs: 5 };

// Docker drops (refuses the listing) for the first `drops` looks, then answers.
const dockerDropping = (drops: number, error: Error): Docker => {
  const looks = new Map<string, number>([['n', 0]]);
  return {
    listContainers: async () => {
      const n = looks.get('n') ?? 0;
      looks.set('n', n + 1);
      if (n < drops) {
        throw error;
      }
      return [{ Id: 'c1', State: 'running' }];
    },
    getContainer: () => ({
      inspect: async () => ({ State: running, RestartCount: 0 }),
    }),
  } as unknown as Docker;
};

const refused = Object.assign(new Error('connect ECONNREFUSED docker.sock'), {
  code: 'ECONNREFUSED',
});

const loadWithDockerWait = (waits: number[]) =>
  loadWithStubs<{ default: VerifyServiceStable }>(
    path.resolve(__dirname, './verifyServiceStable'),
    {
      [path.resolve(
        __dirname,
        '../dockerode/waitForDockerOutage/waitForDockerOutage',
      )]: {
        default: async () => {
          waits.push(waits.length);
        },
      },
    },
  ).default;

describe('verifyServiceStable', () => {
  it('passes once the container stayed up for the window', async () => {
    await assert.doesNotReject(
      verifyServiceStable(
        dockerSeeing([{ state: running, restarts: 0 }]),
        'grafana',
        fast,
      ),
    );
  });

  it('fails when the new container keeps restarting', async () => {
    await assert.rejects(
      verifyServiceStable(
        dockerSeeing([
          { state: running, restarts: 0 },
          {
            state: { Status: 'running', Restarting: true, ExitCode: 3 },
            restarts: 1,
          },
        ]),
        'grafana',
        fast,
      ),
      /grafana is not staying up after the update \(restarting, exit code 3, restarts 1\)/,
    );
  });

  it('fails when the healthcheck reports unhealthy', async () => {
    await assert.rejects(
      verifyServiceStable(
        dockerSeeing([
          {
            state: { ...running, Health: { Status: 'unhealthy' } },
            restarts: 0,
          },
        ]),
        'chronos',
        fast,
      ),
      /chronos is unhealthy/,
    );
  });

  it('waits for "healthy" and fails if it never comes', async () => {
    await assert.rejects(
      verifyServiceStable(
        dockerSeeing([
          {
            state: { ...running, Health: { Status: 'starting' } },
            restarts: 0,
          },
        ]),
        'core-hub',
        { windowMs: 10, maxWaitMs: 60, pollMs: 5 },
      ),
      /did not become ready/,
    );
  });

  it('waits for Docker when it drops and goes on observing the service', async () => {
    const waits: number[] = [];
    const verify = loadWithDockerWait(waits);
    await assert.doesNotReject(
      verify(dockerDropping(2, refused), 'grafana', fast),
    );
    assert.equal(waits.length, 2);
  });

  it('gives up when Docker keeps dropping', async () => {
    const waits: number[] = [];
    const verify = loadWithDockerWait(waits);
    await assert.rejects(
      verify(dockerDropping(10, refused), 'grafana', fast),
      /ECONNREFUSED/,
    );
    assert.equal(waits.length, 2);
  });

  it('does not wait for Docker on an error that is not a connection problem', async () => {
    const waits: number[] = [];
    const verify = loadWithDockerWait(waits);
    await assert.rejects(
      verify(
        dockerDropping(1, new Error('no such container')),
        'grafana',
        fast,
      ),
      /no such container/,
    );
    assert.equal(waits.length, 0);
  });

  it('does nothing when the verify window is 0', async () => {
    const docker = {
      listContainers: async () => {
        throw new Error('must not be called');
      },
    } as unknown as Docker;
    await assert.doesNotReject(
      verifyServiceStable(docker, 'grafana', { windowMs: 0 }),
    );
  });

  it('fails when no container exists for the service', async () => {
    const docker = {
      listContainers: async () => [],
    } as unknown as Docker;
    await assert.rejects(
      verifyServiceStable(docker, 'grafana', fast),
      /no container found for grafana after the update/,
    );
  });

  describe('window from the environment', () => {
    const saved = process.env.UPDATE_VERIFY_SECONDS;
    afterEach(() => {
      if (saved === undefined) {
        delete process.env.UPDATE_VERIFY_SECONDS;
      } else {
        process.env.UPDATE_VERIFY_SECONDS = saved;
      }
    });

    it('UPDATE_VERIFY_SECONDS=0 disables the check', async () => {
      process.env.UPDATE_VERIFY_SECONDS = '0';
      const docker = {
        listContainers: async () => {
          throw new Error('must not be called');
        },
      } as unknown as Docker;
      await assert.doesNotReject(verifyServiceStable(docker, 'grafana'));
    });

    it('ignores a value that is not a number and keeps the default', async () => {
      process.env.UPDATE_VERIFY_SECONDS = 'soon';
      // Default window is 20s: the missing container is reported on the first poll.
      const docker = {
        listContainers: async () => [],
      } as unknown as Docker;
      await assert.rejects(
        verifyServiceStable(docker, 'grafana'),
        /no container found/,
      );
    });
  });
});
