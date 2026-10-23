import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type Docker from 'dockerode';

import verifyServiceStable from './verifyServiceStable';

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
