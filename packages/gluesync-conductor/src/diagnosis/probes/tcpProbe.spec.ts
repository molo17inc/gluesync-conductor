import assert from 'node:assert/strict';
import net, { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import runTcpProbe from './tcpProbe';

const listen = (server: net.Server): Promise<number> =>
  new Promise(resolve => {
    server.listen(0, '127.0.0.1', () =>
      resolve((server.address() as AddressInfo).port),
    );
  });

const close = (server: net.Server): Promise<void> =>
  new Promise(resolve => {
    server.close(() => resolve());
  });

describe('runTcpProbe', () => {
  it('reports a port that accepts connections', async () => {
    const server = net.createServer(socket => socket.end());
    const port = await listen(server);

    const result = await runTcpProbe('127.0.0.1', port, 2000, () => 0);
    await close(server);

    assert.equal(result.id, 'proxy');
    assert.equal(result.reachable, true);
    assert.equal(result.healthy, true);
    assert.equal(result.detail, `127.0.0.1:${port} accepts connections`);
  });

  it('classifies a refused connection and keeps the error code in the detail', async () => {
    const server = net.createServer();
    const port = await listen(server);
    await close(server);

    const result = await runTcpProbe('127.0.0.1', port, 2000, () => 0);

    assert.equal(result.reachable, false);
    assert.equal(result.errorKind, 'refused');
    assert.equal(result.errorCode, 'ECONNREFUSED');
    assert.equal(result.detail, `127.0.0.1:${port} refused (ECONNREFUSED)`);
  });
});
