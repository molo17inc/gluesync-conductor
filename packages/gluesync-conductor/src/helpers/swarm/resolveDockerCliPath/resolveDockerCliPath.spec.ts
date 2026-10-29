import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import loadWithStubs from '../../../testing/loadWithStubs';

const originalOverride = process.env.DOCKER_CLI_PATH;
const originalPlatform = process.platform;
const originalSystemRoot = process.env.SystemRoot;
const originalProgramFiles = process.env.ProgramFiles;

const restore = (name: string, value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
};

const runningOn = (platform: NodeJS.Platform): void => {
  Object.defineProperty(process, 'platform', { value: platform });
};

afterEach(() => {
  restore('DOCKER_CLI_PATH', originalOverride);
  restore('SystemRoot', originalSystemRoot);
  restore('ProgramFiles', originalProgramFiles);
  runningOn(originalPlatform);
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

  describe('on Windows', () => {
    it('finds the CLI the Conductor image copies into System32', () => {
      runningOn('win32');
      delete process.env.DOCKER_CLI_PATH;
      process.env.SystemRoot = 'C:\\Windows';

      assert.equal(
        load(['C:\\Windows\\System32\\docker.exe'])(),
        'C:\\Windows\\System32\\docker.exe',
      );
    });

    it('falls back to the static Docker Engine install in Program Files', () => {
      runningOn('win32');
      delete process.env.DOCKER_CLI_PATH;
      process.env.ProgramFiles = 'C:\\Program Files';

      assert.equal(
        load(['C:\\Program Files\\docker\\docker.exe'])(),
        'C:\\Program Files\\docker\\docker.exe',
      );
    });

    it('does not look at the Linux locations', () => {
      runningOn('win32');
      delete process.env.DOCKER_CLI_PATH;

      assert.throws(
        () => load(['/usr/bin/docker'])(),
        /docker CLI not found in .*System32.*docker\.exe/,
      );
    });

    it('still prefers DOCKER_CLI_PATH', () => {
      runningOn('win32');
      process.env.DOCKER_CLI_PATH = 'D:\\tools\\docker.exe';

      assert.equal(
        load(['D:\\tools\\docker.exe', 'C:\\Windows\\System32\\docker.exe'])(),
        'D:\\tools\\docker.exe',
      );
    });
  });
});
