/* eslint-disable functional/immutable-data, functional/no-let -- a recorder and a fake event stream for the test */
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';

import type { HealProxyErrorPagesOutcome } from './healProxyErrorPages.model';
import watchProxyStartEvents from './watchProxyStartEvents';

const wait = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

const startEvent = (ms: number): string =>
  `${JSON.stringify({ Type: 'container', Action: 'start', timeNano: ms * 1e6 })}\n`;

const setUp = (
  extra: Partial<Parameters<typeof watchProxyStartEvents>[0]> = {},
) => {
  const streams: PassThrough[] = [];
  const filters: unknown[] = [];
  const heals: string[] = [];
  const docker = {
    getEvents: async (options: { filters: unknown }) => {
      filters.push(options.filters);
      const stream = new PassThrough();
      streams.push(stream);
      return stream;
    },
  };
  const watcher = watchProxyStartEvents({
    docker: docker as never,
    proxyServiceName: 'reverse-proxy',
    debounceMs: 30,
    reconnectMs: 10,
    heal: async ({ reason }): Promise<HealProxyErrorPagesOutcome> => {
      heals.push(reason);
      return { action: 'none', reason: 'test' };
    },
    ownRecreateEndedAt: () => 0,
    isHealing: () => false,
    ...extra,
  });

  return { watcher, streams, filters, heals };
};

describe('watchProxyStartEvents', () => {
  it('asks Docker for the start events of the reverse-proxy container only', async () => {
    const { watcher, filters } = setUp();
    await wait(10);

    assert.deepEqual(filters[0], {
      type: ['container'],
      event: ['start'],
      label: ['com.docker.compose.service=reverse-proxy'],
    });
    watcher.stop();
  });

  it('heals once after a burst of start events (debounced)', async () => {
    const { watcher, streams, heals } = setUp();
    await wait(10);

    streams[0].write(startEvent(Date.now()));
    await wait(10);
    streams[0].write(startEvent(Date.now()));
    streams[0].write('not json\n');
    await wait(100);

    assert.deepEqual(heals, ['event']);
    watcher.stop();
  });

  it('ignores the start of the container the heal itself recreated', async () => {
    const at = Date.now();
    const { watcher, streams, heals } = setUp({
      ownRecreateEndedAt: () => at + 500,
    });
    await wait(10);

    streams[0].write(startEvent(at));
    await wait(100);

    assert.deepEqual(heals, []);
    watcher.stop();
  });

  it('reacts to a start that comes after the heal own recreate', async () => {
    const at = Date.now();
    const { watcher, streams, heals } = setUp({
      ownRecreateEndedAt: () => at - 60_000,
    });
    await wait(10);

    streams[0].write(startEvent(at));
    await wait(100);

    assert.deepEqual(heals, ['event']);
    watcher.stop();
  });

  it('waits while an update or another heal is running', async () => {
    const state = { busy: true };
    const { watcher, streams, heals } = setUp({ isBusy: () => state.busy });
    await wait(10);

    streams[0].write(startEvent(Date.now()));
    await wait(120);
    assert.deepEqual(heals, []);

    state.busy = false;
    await wait(80);
    assert.deepEqual(heals, ['event']);
    watcher.stop();
  });

  it('watches again when the event stream ends', async () => {
    const { watcher, streams, filters } = setUp();
    await wait(10);

    streams[0].end();
    await wait(60);

    assert.equal(filters.length, 2);
    watcher.stop();
  });

  it('does nothing after stop', async () => {
    const { watcher, streams, heals } = setUp();
    await wait(10);

    streams[0].write(startEvent(Date.now()));
    watcher.stop();
    await wait(100);

    assert.deepEqual(heals, []);
    assert.equal(streams[0].destroyed, true);
  });
});
