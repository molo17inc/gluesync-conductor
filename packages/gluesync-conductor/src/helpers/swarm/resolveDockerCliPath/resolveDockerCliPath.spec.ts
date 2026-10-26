import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import loadWithStubs from '../../../testing/loadWithStubs';

const originalOverride = process.env.DOCKER_CLI_PATH;

afterEach(() => {
  if (originalOverride === undefined) {
    delete process.env.DOCKER_CLI_PATH;
  } else {
    process.env.DOCKER_CLI_PATH = originalOverride;
  }
});

const load = (existing: ReadonlyArray<string>) =>
  loadWithStubs<{ default: () => string }>(
    path.resolve(__dirname, './resolveDockerCliPath'),
    { 'node:fs': { existsSync: (file: string) => existing.includes(file) } },
  ).default;

describe('resolveDockerCliPath', () => {
  it('takes the first of the fixed system locations that exists', () => {
    delete process.env.DOCKER_CLI_PATH;

    assert.equal(load(['/bin/docker', '/usr/bin/docker'])(), '/usr/bin/docker');
    assert.equal(
      load(['/usr/local/bin/docker', '/usr/bin/docker'])(),
      '/usr/local/bin/docker',
    );
  });

  it('prefers DOCKER_CLI_PATH when that file exists', () => {
    process.env.DOCKER_CLI_PATH = '/opt/docker/bin/docker';

    assert.equal(
      load(['/opt/docker/bin/docker', '/usr/bin/docker'])(),
      '/opt/docker/bin/docker',
    );
  });

  it('ignores a DOCKER_CLI_PATH that does not exist', () => {
    process.env.DOCKER_CLI_PATH = '/nowhere/docker';

    assert.equal(load(['/usr/bin/docker'])(), '/usr/bin/docker');
  });

  it('never falls back to a bare `docker` looked up on PATH', () => {
    delete process.env.DOCKER_CLI_PATH;

    assert.throws(() => load([])(), /docker CLI not found.*DOCKER_CLI_PATH/);
  });
});
