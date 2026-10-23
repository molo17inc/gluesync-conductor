/* eslint-disable functional/no-let, functional/immutable-data, functional/prefer-immutable-types */
// The fake proxy is a real socket server, the logger and the log sink are mutable by nature.
import assert from 'node:assert/strict';
import net, { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import axios, { AxiosError } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import pino from 'pino';

import { LOG_REDACTION } from './logger';

const PASSWORD = 'S3CR3T-proxy-pass';

// A proxy that answers every CONNECT with a 503, so axios fails with an
// AxiosError that carries the request, the response and the proxy agent.
const startProxy = async (): Promise<net.Server> => {
  const server = net.createServer(socket => {
    socket.once('data', () => {
      socket.end(
        'HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n',
      );
    });
  });

  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });

  return server;
};

const failThroughProxy = async (server: net.Server): Promise<AxiosError> => {
  const { port } = server.address() as AddressInfo;

  try {
    await axios.get('https://api.backoffice.example/agent/core-hub/version', {
      proxy: false,
      httpsAgent: new HttpsProxyAgent(
        `http://alice:${PASSWORD}@127.0.0.1:${port}`,
      ),
      timeout: 2000,
    });
  } catch (error) {
    if (axios.isAxiosError(error)) {
      return error;
    }
    throw error;
  }

  throw new Error('the request through the fake proxy should have failed');
};

const captureLogger = () => {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });

  return { lines, logger: pino({ redact: LOG_REDACTION }, sink) };
};

describe('logger redaction of a real proxied AxiosError', () => {
  let proxy: net.Server;
  let error: AxiosError;

  before(async () => {
    proxy = await startProxy();
    error = await failThroughProxy(proxy);
  });

  after(() => {
    proxy.close();
  });

  it('the fixture really carries the password somewhere', () => {
    assert.ok(
      JSON.stringify(error.config?.httpsAgent?.proxy).includes(PASSWORD),
    );
  });

  // `{ error }` is how Conductor's own code logs; `{ err }` and a bare error
  // argument are what Fastify's error handler and req.log.error(error) produce.
  [
    ['{ error }', (log: pino.Logger) => log.error({ error }, 'failed')],
    ['{ err }', (log: pino.Logger) => log.error({ err: error }, 'failed')],
    ['a bare error', (log: pino.Logger) => log.error(error, 'failed')],
    [
      'an error nested one level deeper',
      (log: pino.Logger) => log.error({ ctx: { error } }, 'failed'),
    ],
  ].forEach(([label, write]) => {
    it(`keeps the proxy password out of ${label as string}`, () => {
      const { lines, logger } = captureLogger();

      (write as (log: pino.Logger) => void)(logger);

      assert.equal(lines.length, 1);
      assert.ok(!lines[0].includes(PASSWORD), lines[0].slice(0, 400));
    });
  });
});
