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
    debounceMs: 150, // wide enough that a slow CI runner keeps a burst inside one window
    reconnectMs: 10,
    heal: async ({ reason }): Promise<HealProxyErrorPagesOutcome> => {
      heals.push(reason);
      return { action: 'none', reason: 'test' };
    },
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
    await wait(500);

    assert.deepEqual(heals, ['event']);
    watcher.stop();
  });

  it('still heals once after the debounce when the start event is the one of the heal own recreate', async () => {
    const { watcher, streams, heals } = setUp();
    await wait(10);

    streams[0].write(startEvent(Date.now()));
    await wait(500);

    assert.deepEqual(heals, ['event']);
    watcher.stop();
  });

  it('heals exactly once for a burst that mixes the own recreate start and an external start', async () => {
    const { watcher, streams, heals } = setUp();
    await wait(10);

    const own = Date.now();
    streams[0].write(startEvent(own));
    await wait(10);
    streams[0].write(startEvent(own + 250)); // the external recreate, inside the same debounce window
    await wait(500);

    assert.deepEqual(heals, ['event']);
    watcher.stop();
  });

  it('waits while an update or another heal is running', async () => {
    const state = { busy: true };
    const { watcher, streams, heals } = setUp({ isBusy: () => state.busy });
    await wait(10);

    streams[0].write(startEvent(Date.now()));
    await wait(600);
    assert.deepEqual(heals, []);

    state.busy = false;
    await wait(400);
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
    await wait(500);

    assert.deepEqual(heals, []);
    assert.equal(streams[0].destroyed, true);
  });
});
