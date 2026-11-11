import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import loadWithStubs from '../../testing/loadWithStubs';
import { servicesToStart } from './upAdoptedServices';

const here = (p: string): string => path.resolve(__dirname, p);

const load = (startFails: ReadonlySet<string> = new Set()) => {
  const events: string[] = [];
  const upAdoptedServices = loadWithStubs<{
    default: (docker: unknown, ids: ReadonlyArray<string>) => Promise<void>;
  }>(here('./upAdoptedServices'), {
    [here('../../utils/logger')]: {
      getLogger: () => ({ info: () => 0, error: () => 0 }),
    },
    [here('../dockerode/createActions/createActions')]: {
      default: () => ({
        start: async (id: string) => {
          events.push(`start ${id}`);
          if (startFails.has(id)) {
            throw new Error('up failed');
          }
        },
      }),
    },
    [here('../ensureVolumeDirs/ensureVolumeDirs')]: {
      default: async (id: string) => {
        events.push(`folders ${id}`);
      },
    },
  }).default;
  return { upAdoptedServices, events };
};

describe('upAdoptedServices', () => {
  it('prepares the bind folders of each service before starting it, on Linux too', async () => {
    delete process.env.IS_WINDOWS;
    const { upAdoptedServices, events } = load();

    await upAdoptedServices({}, ['grafana', 'gs-agent-1']);

    assert.deepEqual(
      events.filter(event => event.endsWith('grafana')),
      ['folders grafana', 'start grafana'],
    );
    assert.deepEqual(
      events.filter(event => event.endsWith('gs-agent-1')),
      ['folders gs-agent-1', 'start gs-agent-1'],
    );
  });

  it('starts a service reported by several adoption steps once', async () => {
    const { upAdoptedServices, events } = load();

    await upAdoptedServices({}, [
      'gluesync-core-hub',
      'gluesync-chronos',
      'gluesync-core-hub',
      'gluesync-conductor',
      'gluesync-core-hub',
    ]);

    assert.deepEqual(
      events.filter(event => event.startsWith('start ')).sort(),
      ['start gluesync-chronos', 'start gluesync-core-hub'],
    );
  });

  it('leaves the conductor to the healer', async () => {
    const { upAdoptedServices, events } = load();

    await upAdoptedServices({}, ['gluesync-conductor']);

    assert.deepEqual(events, []);
  });

  it('keeps going when one service fails to start', async () => {
    const { upAdoptedServices, events } = load(new Set(['grafana']));

    await upAdoptedServices({}, ['grafana', 'chronos']);

    assert.ok(events.includes('start chronos'));
  });

  it('does nothing without services', async () => {
    const { upAdoptedServices, events } = load();

    await upAdoptedServices({}, []);

    assert.deepEqual(events, []);
  });
});

describe('servicesToStart', () => {
  it('keeps each service once, in the order first reported', () => {
    assert.deepEqual(
      servicesToStart(
        [
          'gluesync-core-hub',
          'gluesync-chronos',
          'reverse-proxy',
          'gluesync-core-hub',
          'gluesync-core-hub',
        ],
        'gluesync-conductor',
      ),
      ['gluesync-core-hub', 'gluesync-chronos', 'reverse-proxy'],
    );
  });

  it('never starts the conductor itself', () => {
    assert.deepEqual(
      servicesToStart(
        ['gluesync-conductor', 'gluesync-core-hub', 'gluesync-conductor'],
        'gluesync-conductor',
      ),
      ['gluesync-core-hub'],
    );
  });
});
