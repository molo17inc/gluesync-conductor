import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import fastify, { type FastifyPluginAsync } from 'fastify';
import pino from 'pino';

import loadWithStubs from '../testing/loadWithStubs';

type Subject = Readonly<{ default: FastifyPluginAsync }>;

const load = (waitFails?: Error) => {
  const docker = { id: 'docker-client' };
  const waits: unknown[][] = [];
  const subject = loadWithStubs<Subject>(path.resolve(__dirname, './docker'), {
    [path.resolve(__dirname, '../utils/docker/getDocker')]: {
      getDocker: () => docker,
    },
    [path.resolve(__dirname, '../utils/docker/dockerSafeCall')]: {
      default: async (fn: (d: unknown) => Promise<unknown>) => fn(docker),
    },
    [path.resolve(
      __dirname,
      '../helpers/dockerode/waitForDockerDaemon/waitForDockerDaemon',
    )]: {
      default: async (...args: unknown[]) => {
        waits.push(args);
        if (waitFails) {
          throw waitFails;
        }
      },
    },
    [path.resolve(__dirname, '../utils/logger')]: {
      getLogger: () => ({ id: 'logger' }),
    },
  });
  const lines: Record<string, unknown>[] = [];
  const app = fastify({
    loggerInstance: pino(
      { level: 'info', serializers: { error: pino.stdSerializers.err } },
      { write: (line: string) => lines.push(JSON.parse(line)) },
    ),
  });
  return { app, subject, docker, waits, lines };
};

describe('docker plugin', () => {
  it('waits for the daemon, then exposes the client and the safe wrapper', async () => {
    const { app, subject, docker, waits, lines } = load();
    await app.register(subject.default);
    await app.ready();
    assert.equal((app as any).docker, docker);
    assert.equal(typeof (app as any).dockerSafeCall, 'function');
    assert.deepEqual(waits[0][1], { id: 'logger' });
    assert.deepEqual(waits[0][2], {
      totalTimeoutMs: 15000,
      perAttemptTimeoutMs: 1500,
    });
    assert.ok(
      lines.some(l => l.msg === 'Docker plugin registered successfully'),
    );
    await app.close();
  });

  it('starts anyway when the daemon does not answer in time', async () => {
    const { app, subject, docker, lines } = load(new Error('not ready'));
    await app.register(subject.default);
    await app.ready();
    assert.equal((app as any).docker, docker);
    assert.equal(typeof (app as any).dockerSafeCall, 'function');
    const warning = lines.find(l =>
      /Docker daemon not ready at startup/.test(String(l.msg)),
    );
    assert.equal(warning?.level, 40);
    assert.equal((warning?.error as { message: string }).message, 'not ready');
    assert.equal(
      lines.some(l => l.msg === 'Docker plugin registered successfully'),
      false,
    );
    await app.close();
  });
});
