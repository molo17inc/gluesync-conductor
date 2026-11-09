import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { describe, it } from 'node:test';
import type net from 'node:net';

import loadWithStubs from '../../testing/loadWithStubs';

type Subject = typeof import('./npipeAgent');

const subject = loadWithStubs<Subject>(path.resolve(__dirname, 'npipeAgent'), {
  [path.resolve(__dirname, '../logger')]: {
    getLogger: () => ({ debug: () => 0 }),
  },
});

const POLICY = { maxAttempts: 4, firstDelayMs: 1, maxDelayMs: 2 };

const codeError = (code: string): Error =>
  Object.assign(new Error(`connect ${code}`), { code });

// A socket that, once the caller has attached its listeners, connects or fails
const fakeSocket = (outcome: Error | 'connect') => {
  const socket = Object.assign(new EventEmitter(), { destroy: () => socket });
  setImmediate(() => {
    if (outcome === 'connect') {
      socket.emit('connect');
    } else {
      socket.emit('error', outcome);
    }
  });
  return socket as unknown as net.Socket;
};

// connect() that plays `outcomes` in order, counting the calls
const scripted = (outcomes: ReadonlyArray<Error | 'connect'>) => {
  const calls: string[] = [];
  const connect = ({ path: pipe }: Readonly<{ path: string }>) => {
    // eslint-disable-next-line functional/immutable-data -- spy
    calls.push(pipe);
    return fakeSocket(outcomes[Math.min(calls.length, outcomes.length) - 1]);
  };
  return { calls, connect };
};

const run = (
  connect: Parameters<Subject['connectToPipe']>[0],
): Promise<{ error: Error | null; socket?: net.Socket }> =>
  new Promise(resolve => {
    subject.connectToPipe(
      connect,
      '//./pipe/docker_engine',
      (error, socket) => resolve({ error, socket }),
      POLICY,
    );
  });

describe('connectToPipe', () => {
  it('connects at once when the pipe is free', async () => {
    const { calls, connect } = scripted(['connect']);
    const { error, socket } = await run(connect);

    assert.equal(error, null);
    assert.ok(socket);
    assert.deepEqual(calls, ['//./pipe/docker_engine']);
  });

  it('retries ENOENT and hands over the socket that connects', async () => {
    const { calls, connect } = scripted([
      codeError('ENOENT'),
      codeError('ENOENT'),
      'connect',
    ]);
    const { error, socket } = await run(connect);

    assert.equal(error, null);
    assert.ok(socket);
    assert.equal(calls.length, 3);
  });

  it('retries EBUSY', async () => {
    const { calls, connect } = scripted([codeError('EBUSY'), 'connect']);
    const { error } = await run(connect);

    assert.equal(error, null);
    assert.equal(calls.length, 2);
  });

  it('fails at once on an error that is not a busy pipe', async () => {
    await Promise.all(
      ['ECONNREFUSED', 'EACCES'].map(async code => {
        const { calls, connect } = scripted([codeError(code), 'connect']);
        const { error, socket } = await run(connect);

        assert.equal((error as NodeJS.ErrnoException).code, code);
        assert.equal(socket, undefined);
        assert.equal(calls.length, 1);
      }),
    );
  });

  it('gives up after the last attempt with the last error', async () => {
    const { calls, connect } = scripted([
      codeError('ENOENT'),
      codeError('ENOENT'),
      codeError('ENOENT'),
      codeError('EBUSY'),
      'connect',
    ]);
    const { error } = await run(connect);

    assert.equal((error as NodeJS.ErrnoException).code, 'EBUSY');
    assert.equal(calls.length, POLICY.maxAttempts);
  });

  it('does not retry an error after the socket connected', async () => {
    const calls: number[] = [];
    const socket = Object.assign(new EventEmitter(), {
      destroy: () => socket,
    });
    const connect = () => {
      // eslint-disable-next-line functional/immutable-data -- spy
      calls.push(1);
      return socket as unknown as net.Socket;
    };

    const results: Array<Error | null> = [];
    subject.connectToPipe(
      connect,
      '//./pipe/docker_engine',
      error => {
        // eslint-disable-next-line functional/immutable-data -- spy
        results.push(error);
      },
      POLICY,
    );
    socket.emit('connect');
    socket.emit('error', codeError('ENOENT'));
    await new Promise(resolve => {
      setTimeout(resolve, 20);
    });

    assert.deepEqual(results, [null]);
    assert.equal(calls.length, 1);
  });
});

describe('createNpipeAgent', () => {
  it('connects through the callback with the request socketPath', async () => {
    const { calls, connect } = scripted([codeError('ENOENT'), 'connect']);
    const agent = subject.createNpipeAgent(connect, POLICY) as unknown as {
      createConnection: (
        options: unknown,
        callback: (error: Error | null, socket?: net.Socket) => void,
      ) => unknown;
    };

    const result = await new Promise<{ error: Error | null; socket?: unknown }>(
      resolve => {
        const returned = agent.createConnection(
          { socketPath: '//./pipe/docker_engine' },
          (error, socket) => resolve({ error, socket }),
        );
        assert.equal(returned, undefined);
      },
    );

    assert.equal(result.error, null);
    assert.ok(result.socket);
    assert.deepEqual(calls, [
      '//./pipe/docker_engine',
      '//./pipe/docker_engine',
    ]);
  });
});
