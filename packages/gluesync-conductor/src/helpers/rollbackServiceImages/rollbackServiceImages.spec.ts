import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import loadWithStubs from '../../testing/loadWithStubs';
import type { ServiceObservation } from '../serviceContainers/serviceContainers.model';
import type { RollbackServiceImages } from './rollbackServiceImages.model';

const here = (p: string): string => path.resolve(__dirname, p);

type Setup = Readonly<{
  upFails?: ReadonlySet<string>;
  writeError?: Error;
  dockerDownError?: Error;
  // What the next look at a service finds, per service; the last one repeats.
  observations?: Readonly<Record<string, ReadonlyArray<ServiceObservation>>>;
  // Fingerprints of the containers now (before the rollback they were taken earlier).
  now?: Readonly<Record<string, string>>;
}>;

const up = (detail: string): ServiceObservation => ({
  running: true,
  image: detail,
  detail: 'running',
});
const stopped: ServiceObservation = {
  running: false,
  image: 'x',
  detail: 'exited',
};

const load = ({
  upFails = new Set<string>(),
  writeError,
  dockerDownError,
  observations = {},
  now = {},
}: Setup = {}) => {
  const written: unknown[] = [];
  const events: string[] = [];
  const looks = new Map<string, number>();
  // The compose file as the rollback leaves it: a service's image is read back.
  const files = {
    current: {
      version: '3',
      services: {
        grafana: { image: 'grafana:new' },
        chronos: { image: 'chronos:1' },
      },
    },
  };
  const rollback = loadWithStubs<{ default: RollbackServiceImages }>(
    here('./rollbackServiceImages'),
    {
      [here('../composeFile/readComposeFile/readComposeFile')]: {
        readComposeFile: async () => files.current,
      },
      [here('../composeFile/writeComposeFile/writeComposeFile')]: {
        default: async (compose: typeof files.current) => {
          if (writeError) {
            throw writeError;
          }
          written.push(compose);
          files.current = compose;
        },
      },
      [here('../dockerode/createActions/createActions')]: {
        runCmd: async (_cmd: unknown, id: string) => {
          events.push(`up ${id}`);
          if (upFails.has(id)) {
            throw new Error(`up ${id} failed`);
          }
        },
      },
      [here('../dockerode/waitForDockerOutage/waitForDockerOutage')]: {
        default: async () => {
          events.push('wait for docker');
          if (dockerDownError) {
            throw dockerDownError;
          }
        },
      },
      [here('../serviceContainers/serviceContainers')]: {
        fingerprintServices: async () => now,
        observeService: async (_docker: unknown, id: string) => {
          const list = observations[id] ?? [
            up(files.current.services[id as 'grafana']?.image ?? ''),
          ];
          const n = looks.get(id) ?? 0;
          looks.set(id, n + 1);
          return list[Math.min(n, list.length - 1)];
        },
      },
    },
  ).default;
  return { rollback, written, events };
};

const docker = {} as never;
const before = { grafana: 'g1', chronos: 'c1' };
const restore = (extra: Record<string, unknown> = {}) => ({
  recreate: true as const,
  docker,
  before,
  services: ['grafana', 'chronos'],
  ...extra,
});

const ups = (events: ReadonlyArray<string>): string[] =>
  events.filter(e => e.startsWith('up '));

describe('rollbackServiceImages', () => {
  it('does nothing without rollbacks', async () => {
    const { rollback, written } = load();
    assert.deepEqual(await rollback([], restore()), []);
    assert.equal(written.length, 0);
  });

  it('puts the old image back in the compose file without recreating', async () => {
    const { rollback, written, events } = load();
    const result = await rollback([{ id: 'grafana', image: 'grafana:old' }], {
      recreate: false,
    });
    assert.deepEqual(result, [
      { id: 'grafana', image: 'grafana:old', ok: true },
    ]);
    assert.deepEqual(written, [
      {
        version: '3',
        services: {
          grafana: { image: 'grafana:old' },
          chronos: { image: 'chronos:1' },
        },
      },
    ]);
    assert.deepEqual(events, []);
  });

  it('recreates each touched service and reports the ones that fail', async () => {
    const { rollback, events } = load({
      upFails: new Set(['chronos']),
      now: { grafana: 'g2', chronos: 'c2' },
      observations: { grafana: [up('grafana:old')], chronos: [stopped] },
    });
    const result = await rollback(
      [
        { id: 'grafana', image: 'grafana:old' },
        { id: 'chronos', image: 'chronos:0' },
      ],
      restore(),
    );
    // chronos is tried again by the final check, and still fails.
    assert.deepEqual(ups(events), [
      'up grafana',
      'up chronos',
      'up chronos',
      'up chronos',
    ]);
    assert.deepEqual(result, [
      { id: 'grafana', image: 'grafana:old', ok: true },
      {
        id: 'chronos',
        image: 'chronos:0',
        ok: false,
        error: 'up chronos failed',
      },
    ]);
  });

  it('leaves alone a service the failed update never touched', async () => {
    const { rollback, written, events } = load({
      now: { grafana: 'g1', chronos: 'c2' },
      observations: {
        grafana: [up('grafana:old')],
        chronos: [up('chronos:0')],
      },
    });
    const result = await rollback(
      [
        { id: 'grafana', image: 'grafana:old' },
        { id: 'chronos', image: 'chronos:0' },
      ],
      restore(),
    );
    assert.deepEqual(result, [
      { id: 'grafana', image: 'grafana:old', ok: true, untouched: true },
      { id: 'chronos', image: 'chronos:0', ok: true },
    ]);
    assert.deepEqual(ups(events), ['up chronos']);
    // The compose file goes back for both.
    assert.equal(written.length, 1);
  });

  it('waits for Docker before recreating, then starts a service that is not running', async () => {
    const { rollback, events } = load({
      now: { grafana: 'g2', chronos: 'c1' },
      observations: {
        grafana: [up('grafana:old')],
        // Stopped after the rollback's own `up`; running once the final check started it.
        chronos: [stopped, up('chronos:1')],
      },
    });
    const result = await rollback(
      [{ id: 'grafana', image: 'grafana:old' }],
      restore(),
    );
    assert.deepEqual(events, ['wait for docker', 'up grafana', 'up chronos']);
    assert.deepEqual(result, [
      { id: 'grafana', image: 'grafana:old', ok: true },
    ]);
  });

  it('starts a service whose container runs another image than the compose file', async () => {
    const { rollback, events } = load({
      now: { grafana: 'g1', chronos: 'c1' },
      observations: {
        grafana: [up('grafana:old')],
        chronos: [up('chronos:2'), up('chronos:1')],
      },
    });
    await rollback([{ id: 'grafana', image: 'grafana:old' }], restore());
    assert.deepEqual(ups(events), ['up chronos']);
  });

  it('names a service it could not bring back instead of reporting it fine', async () => {
    const { rollback, events } = load({
      now: { grafana: 'g2', chronos: 'c1' },
      observations: {
        grafana: [up('grafana:old')],
        chronos: [stopped],
      },
    });
    const result = await rollback(
      [{ id: 'grafana', image: 'grafana:old' }],
      restore(),
    );
    // Two attempts, then the report.
    assert.deepEqual(ups(events), ['up grafana', 'up chronos', 'up chronos']);
    assert.deepEqual(result, [
      { id: 'grafana', image: 'grafana:old', ok: true },
      {
        id: 'chronos',
        image: '',
        ok: false,
        error: 'chronos is not running (exited)',
      },
    ]);
  });

  it('does not check the conductor, whose own update restarts it', async () => {
    const { rollback, events } = load({
      now: {},
      observations: { 'gluesync-conductor': [stopped] },
    });
    await rollback(
      [{ id: 'grafana', image: 'grafana:old' }],
      restore({ services: ['grafana', 'gluesync-conductor'] }),
    );
    assert.equal(events.includes('up gluesync-conductor'), false);
  });

  it('reports every service as not restored when Docker does not come back', async () => {
    const down = Object.assign(
      new Error('Docker daemon not ready within 60000ms'),
      {
        code: 'ETIMEDOUT',
      },
    );
    const { rollback, written, events } = load({ dockerDownError: down });
    const result = await rollback(
      [
        { id: 'grafana', image: 'grafana:old' },
        { id: 'chronos', image: 'chronos:0' },
      ],
      restore(),
    );
    // The compose file went back anyway.
    assert.equal(written.length, 1);
    assert.deepEqual(events, ['wait for docker']);
    result.forEach(outcome => {
      assert.equal(outcome.ok, false);
      assert.match(
        outcome.error ?? '',
        /Docker is not reachable: Docker daemon not ready within 60000ms/,
      );
    });
  });

  it('reports a compose file it cannot write instead of throwing, and does not recreate', async () => {
    const full = Object.assign(new Error('write ENOSPC'), { code: 'ENOSPC' });
    const { rollback, written, events } = load({ writeError: full });
    const result = await rollback(
      [
        { id: 'grafana', image: 'grafana:old' },
        { id: 'chronos', image: 'chronos:0' },
      ],
      restore(),
    );
    assert.equal(written.length, 0);
    assert.deepEqual(events, []);
    assert.equal(result.length, 2);
    result.forEach(outcome => {
      assert.equal(outcome.ok, false);
      assert.match(outcome.error ?? '', /compose file could not be restored/);
      assert.match(outcome.error ?? '', /not enough free disk space/);
    });
  });
});
