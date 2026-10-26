/* eslint-disable functional/no-let, functional/immutable-data, functional/prefer-immutable-types */
// The fake proxy is a real socket server, which is inherently imperative and mutable.
import assert from 'node:assert/strict';
import net, { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { HttpsProxyAgent } from 'https-proxy-agent';
import axios from 'axios';

import runHttpProbe, { HttpProbeSpec } from './httpProbe';

// A proxy that answers every CONNECT with the given status line and closes.
const startProxy = async (statusLine: string): Promise<net.Server> => {
  const server = net.createServer(socket => {
    socket.once('data', () => {
      socket.end(`HTTP/1.1 ${statusLine}\r\nContent-Length: 0\r\n\r\n`);
    });
  });

  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });

  return server;
};

const proxyUrl = (server: net.Server): string =>
  `http://user:secret@127.0.0.1:${(server.address() as AddressInfo).port}`;

const SPEC: HttpProbeSpec = {
  id: 'backoffice',
  url: 'https://api.backoffice.example/agent/core-hub/version',
  timeoutMs: 2000,
  isHealthyStatus: status => status >= 200 && status < 300,
  expectMolo17Origin: true,
};

const probeThrough = (server: net.Server) =>
  runHttpProbe(SPEC, {
    request: config => axios.request(config),
    getAgent: () => new HttpsProxyAgent(proxyUrl(server)),
    now: () => 0,
  });

describe('runHttpProbe through a proxy', () => {
  let authProxy: net.Server;
  let refusingProxy: net.Server;

  before(async () => {
    authProxy = await startProxy('407 Proxy Authentication Required');
    refusingProxy = await startProxy('503 Service Unavailable');
  });

  after(() => {
    authProxy.close();
    refusingProxy.close();
  });

  it('marks a 407 from the proxy as proxy-auth', async () => {
    const { result } = await probeThrough(authProxy);

    assert.equal(result.httpStatus, 407);
    assert.equal(result.errorKind, 'proxy-auth');
    assert.equal(result.reachable, true);
    assert.equal(result.healthy, false);
    // No MOLO17 edge headers: the proxy answered, not MOLO17.
    assert.equal(result.origin, 'intermediary');
  });

  it('reports any other refusal as an HTTP answer from an intermediary', async () => {
    const { result } = await probeThrough(refusingProxy);

    assert.equal(result.httpStatus, 503);
    assert.equal(result.errorKind, undefined);
    assert.equal(result.origin, 'intermediary');
  });

  it('never puts the proxy credentials in the result', async () => {
    const { result } = await probeThrough(authProxy);

    assert.ok(!JSON.stringify(result).includes('secret'));
  });
});
