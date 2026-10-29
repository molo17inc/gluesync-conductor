import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type Docker from 'dockerode';

import waitForDockerOutage, { dockerWaitMs } from './waitForDockerOutage';

const saved = process.env.CONDUCTOR_DOCKER_WAIT_MS;
afterEach(() => {
  if (saved === undefined) {
    delete process.env.CONDUCTOR_DOCKER_WAIT_MS;
  } else {
    process.env.CONDUCTOR_DOCKER_WAIT_MS = saved;
  }
});

const pings = (): { docker: Docker; count: () => number } => {
  const seen: number[] = [];
  const docker = {
    ping: async () => {
      seen.push(seen.length);
      return 'OK';
    },
  } as unknown as Docker;
  return { docker, count: () => seen.length };
};

describe('dockerWaitMs', () => {
  it('defaults to a minute', () => {
    delete process.env.CONDUCTOR_DOCKER_WAIT_MS;
    assert.equal(dockerWaitMs(), 60000);
  });

  it('reads CONDUCTOR_DOCKER_WAIT_MS every time it is called', () => {
    process.env.CONDUCTOR_DOCKER_WAIT_MS = '1500';
    assert.equal(dockerWaitMs(), 1500);
    process.env.CONDUCTOR_DOCKER_WAIT_MS = '0';
    assert.equal(dockerWaitMs(), 0);
  });

  it('ignores a value that is not a non-negative number', () => {
    ['soon', '-5', ''].forEach(value => {
      process.env.CONDUCTOR_DOCKER_WAIT_MS = value;
      assert.equal(dockerWaitMs(), 60000);
    });
  });
});

describe('waitForDockerOutage', () => {
  it('returns once Docker answers a ping', async () => {
    const { docker, count } = pings();
    await waitForDockerOutage(docker, 1000);
    assert.equal(count(), 1);
  });

  it('does not wait at all with a budget of 0', async () => {
    process.env.CONDUCTOR_DOCKER_WAIT_MS = '0';
    const { docker, count } = pings();
    await waitForDockerOutage(docker);
    assert.equal(count(), 0);
  });

  it('rejects with a transient error when Docker does not come back in time', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    const docker = {
      ping: async () => {
        throw refused;
      },
    } as unknown as Docker;
    await assert.rejects(waitForDockerOutage(docker, 300), (error: Error) => {
      assert.match(error.message, /Docker daemon not ready within 300ms/);
      return true;
    });
  });
});
