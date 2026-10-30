import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import isTransientDockerConnError from './isTransientDockerConnError';

describe('isTransientDockerConnError', () => {
  it('recognises the messages docker-compose prints when the daemon is gone', () => {
    [
      'error during connect: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.51/containers/json": EOF',
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
      'failed to connect to the docker API at unix:///x/docker.sock; check if the path is correct',
      'write unix @->/x/sock: write: broken pipe',
      'read unix @->/x/sock: read: connection reset by peer',
      'dial unix /x/sock: connect: connection refused',
      'Cannot connect to Podman. Please verify your connection to the Linux system using `podman system connection list`, or try `podman machine init` and `podman machine start`: unix:///run/user/1000/podman/podman.sock',
      'failed to connect to the docker API at unix:///run/podman/podman.sock',
    ].forEach(message => {
      assert.equal(isTransientDockerConnError({ message }), true, message);
    });
  });

  it('recognises socket error codes', () => {
    ['ECONNREFUSED', 'EPIPE', 'ENOENT', 'ECONNRESET'].forEach(code => {
      assert.equal(isTransientDockerConnError({ code }), true, code);
    });
  });

  it('does not take a real compose failure for an outage', () => {
    [
      'Bind for 0.0.0.0:443 failed: port is already allocated',
      'pull access denied for molo17/grafana, repository does not exist',
      'manifest for molo17/grafana:9.9.9 not found',
    ].forEach(message => {
      assert.equal(isTransientDockerConnError(new Error(message)), false);
    });
  });
});
