/* eslint-disable functional/no-let, functional/immutable-data, functional/prefer-immutable-types */
// Environment variables and the compose "disk" are reset around each test.
import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { hasConductorTypeLabel } from './autoAdoptServices';
import { LabelPrefix } from '../../models/composeFile.model';
import loadWithStubs from '../../testing/loadWithStubs';

const TYPE_LABEL = `${LabelPrefix.CONDUCTOR}.type=agent`;

describe('hasConductorTypeLabel', () => {
  it('is false for a service that is not in the compose file', () => {
    assert.equal(hasConductorTypeLabel(undefined), false);
  });

  it('is false for a service without labels', () => {
    assert.equal(hasConductorTypeLabel({}), false);
  });

  it('finds the type label in the array form', () => {
    assert.equal(hasConductorTypeLabel({ labels: ['a=b', TYPE_LABEL] }), true);
  });

  it('finds the type label in the map form', () => {
    assert.equal(
      hasConductorTypeLabel({
        labels: { [`${LabelPrefix.CONDUCTOR}.type`]: 'agent' },
      }),
      true,
    );
  });

  it('ignores labels that are not the conductor type', () => {
    assert.equal(
      hasConductorTypeLabel({
        labels: [`${LabelPrefix.CONDUCTOR}.name=x`, 'other.type=agent'],
      }),
      false,
    );
  });
});

type Result = Awaited<ReturnType<typeof import('./autoAdoptServices').default>>;
type Compose = Record<string, any>;

const helpers = (name: string) => path.resolve(__dirname, '..', name);

type Run = Readonly<{
  result: Result;
  written: ReadonlyArray<Compose>;
  recreated: ReadonlyArray<ReadonlyArray<unknown>>;
  retagged: ReadonlyArray<ReadonlyArray<unknown>>;
}>;

type RunOptions = Readonly<{
  proxyId?: string | null;
  retag?: string | undefined;
  readError?: Error;
}>;

const run = async (
  compose: Compose,
  { proxyId = null, retag, readError }: RunOptions = {},
): Promise<Run> => {
  const written: Compose[] = [];
  const recreated: unknown[][] = [];
  const retagged: unknown[][] = [];

  const subject = loadWithStubs<{ default: () => Promise<Result> }>(
    path.resolve(__dirname, './autoAdoptServices'),
    {
      [helpers('composeFile/readComposeFile/readComposeFile')]: {
        readComposeFile: async () => {
          if (readError) {
            throw readError;
          }
          return structuredClone(compose);
        },
      },
      [helpers('composeFile/writeComposeFile/writeComposeFile')]: {
        default: async (json: Compose) => {
          written.push(json);
        },
      },
      [helpers('healTraefikConf/healTraefikConf')]: {
        default: async () => proxyId,
        findProxyServiceName: () => 'reverse-proxy',
      },
      [helpers('healChronosTraefikRule/healChronosTraefikRule')]: {
        default: async (...args: unknown[]) => {
          recreated.push(args);
        },
      },
      [helpers('retagThirdPartyImageToMolo17/retagThirdPartyImageToMolo17')]: {
        default: async (...args: unknown[]) => {
          retagged.push(args);
          return retag;
        },
      },
    },
  );

  return { result: await subject.default(), written, recreated, retagged };
};

const ENV_KEYS = [
  'IS_WINDOWS',
  'CONDUCTOR_NAME',
  'GLUESYNC_HOST',
  'WINDOWS_YEAR',
] as const;

const labelsOf = (compose: Compose, id: string): ReadonlyArray<string> =>
  compose.services[id].labels;

describe('autoAdoptServices', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    ENV_KEYS.forEach(key => {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    });
  });

  afterEach(() => {
    ENV_KEYS.forEach(key => {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    });
    mock.restoreAll();
  });

  it('does nothing when the compose file has no services', async () => {
    const { result, written } = await run({});

    assert.deepEqual(result, {
      success: true,
      updatedIds: [],
      unmatchedIds: [],
    });
    assert.equal(written.length, 0);
  });

  it('adopts unlabeled services by type and reports unknown images', async () => {
    const { result, written, retagged } = await run({
      services: {
        'gluesync-conductor': { image: 'molo17/gluesync-conductor:2.3.0' },
        'gluesync-core-hub': {
          image: 'molo17/gluesync-core-hub:2.3.0',
          depends_on: ['db'],
        },
        'my-couchbase': {
          image: 'molo17/gluesync-couchbase:2.3.0',
          container_name: 'cb',
          environment: { FOO: 'bar' },
          labels: ['keep=me'],
        },
        mystery: { image: 'acme/mystery:1' },
        grafana: { image: 'molo17/grafana:1' },
      },
    });

    assert.equal(result.success, true);
    assert.deepEqual(result.unmatchedIds, ['mystery']);
    assert.ok(result.updatedIds.includes('my-couchbase'));
    assert.ok(result.updatedIds.includes('gluesync-core-hub'));
    assert.equal(retagged.length, 0);
    assert.equal(written.length, 1);

    const out = written[0];
    const typeLabel = (id: string) => `${LabelPrefix.CONDUCTOR}.type=${id}`;
    assert.deepEqual(labelsOf(out, 'my-couchbase'), [
      'keep=me',
      typeLabel('agent'),
      `${LabelPrefix.CONDUCTOR}.service_id=my-couchbase`,
    ]);
    assert.deepEqual(out.services['my-couchbase'].environment, ['FOO=bar']);
    assert.equal(out.services['my-couchbase'].container_name, undefined);
    assert.deepEqual(labelsOf(out, 'gluesync-core-hub'), [
      typeLabel('core-hub'),
    ]);
    assert.equal(out.services['gluesync-core-hub'].depends_on, undefined);
    assert.ok(out.services['gluesync-core-hub'].ports.includes('8765:8765'));
    assert.deepEqual(labelsOf(out, 'grafana'), [typeLabel('third-party')]);
    assert.deepEqual(labelsOf(out, 'gluesync-conductor'), [
      typeLabel('module'),
    ]);
    assert.equal(hasConductorTypeLabel(out.services.mystery), false);
  });

  it('retags a third-party image that is not a Molo17 one', async () => {
    process.env.WINDOWS_YEAR = '2022';
    const { written, retagged } = await run(
      { services: { grafana: { image: 'grafana/grafana:10' } } },
      { retag: 'molo17/grafana:10' },
    );

    assert.deepEqual(retagged, [['grafana/grafana:10', false, '2022']]);
    assert.equal(written[0].services.grafana.image, 'molo17/grafana:10');
    assert.deepEqual(labelsOf(written[0], 'grafana'), [
      `${LabelPrefix.CONDUCTOR}.type=third-party`,
    ]);
  });

  it('leaves a third-party service untouched when no retag exists', async () => {
    const { result, written } = await run(
      { services: { grafana: { image: 'grafana/grafana:10' } } },
      { retag: undefined },
    );

    assert.equal(result.success, true);
    assert.equal(written[0].services.grafana.image, 'grafana/grafana:10');
    assert.equal(written[0].services.grafana.labels, undefined);
  });

  it('applies the Windows adjustments per service type', async () => {
    process.env.IS_WINDOWS = 'true';
    process.env.GLUESYNC_HOST = 'hub-host';
    const { written } = await run({
      services: {
        'my-couchbase': { image: 'molo17/gluesync-couchbase:2.3.0' },
        'gluesync-whisperer': { image: 'molo17/gluesync-whisperer:2.3.0' },
        'gluesync-conductor': { image: 'molo17/gluesync-conductor:2.3.0' },
      },
    });

    const out = written[0];
    assert.ok(
      out.services['my-couchbase'].environment.includes(
        'GLUESYNC_HOST=hub-host',
      ),
    );
    assert.ok(out.services['my-couchbase'].networks);
    assert.ok(out.services['gluesync-whisperer'].networks);
    assert.equal(
      (out.services['gluesync-whisperer'].environment ?? []).some((e: string) =>
        e.startsWith('GLUESYNC_HOST='),
      ),
      false,
    );
    assert.equal(out.services['gluesync-conductor'].networks, undefined);
    assert.deepEqual(out.networks['gluesync-windows-net'], {
      name: 'gluesync-windows-net',
      driver: 'nat',
    });
  });

  it('honors CONDUCTOR_NAME when skipping the conductor service', async () => {
    process.env.IS_WINDOWS = 'true';
    process.env.CONDUCTOR_NAME = 'my-conductor';
    const { written } = await run({
      services: {
        'my-conductor': { image: 'molo17/gluesync-conductor:2.3.0' },
      },
    });

    assert.equal(written[0].services['my-conductor'].networks, undefined);
  });

  it('cleans already-labeled services and recreates healed Chronos containers', async () => {
    const typeLabel = `${LabelPrefix.CONDUCTOR}.type=module`;
    const compose = {
      services: {
        'gluesync-chronos': {
          image: 'molo17/gluesync-chronos:2.3.0',
          labels: [
            typeLabel,
            'traefik.http.routers.chronos.rule=PathPrefix(`/api/`)',
          ],
          depends_on: ['db'],
        },
      },
    };
    const { result, written, recreated } = await run(compose);

    assert.equal(result.success, true);
    assert.deepEqual(result.unmatchedIds, []);
    assert.ok(result.updatedIds.includes('gluesync-chronos'));
    assert.equal(written.length, 1);
    assert.equal(written[0].services['gluesync-chronos'].depends_on, undefined);
    assert.deepEqual(recreated, [[['gluesync-chronos'], 'reverse-proxy']]);
  });

  it('recreates healed Chronos containers after adopting new services', async () => {
    const { written, recreated } = await run({
      services: {
        'gluesync-chronos': {
          image: 'molo17/gluesync-chronos:2.3.0',
          labels: ['traefik.http.routers.chronos.rule=PathPrefix(`/api/`)'],
        },
      },
    });

    assert.equal(written.length, 1);
    assert.deepEqual(recreated, [[['gluesync-chronos'], 'reverse-proxy']]);
  });

  it('is a no-op on a compose file it already normalized', async () => {
    const first = await run({
      services: {
        'my-couchbase': { image: 'molo17/gluesync-couchbase:2.3.0' },
      },
    });
    const normalized = first.written[0];

    const second = await run(normalized);

    assert.deepEqual(second.result, {
      success: true,
      updatedIds: [],
      unmatchedIds: [],
    });
    assert.equal(second.written.length, 0);
    assert.equal(second.recreated.length, 0);
  });

  it('reports the healed Traefik proxy even when nothing else changed', async () => {
    const first = await run({
      services: {
        'my-couchbase': { image: 'molo17/gluesync-couchbase:2.3.0' },
      },
    });

    const second = await run(first.written[0], { proxyId: 'reverse-proxy' });

    assert.deepEqual(second.result.updatedIds, ['reverse-proxy']);
    assert.equal(second.written.length, 1);
  });

  it('skips the write when only unmatched services remain', async () => {
    const first = await run({
      services: { mystery: { image: 'acme/mystery:1' } },
    });

    const second = await run(first.written[0]);

    assert.deepEqual(second.result, {
      success: true,
      updatedIds: [],
      unmatchedIds: ['mystery'],
    });
    assert.equal(second.written.length, 0);
  });

  it('fails soft and logs the reason when reading throws', async () => {
    const logged = mock.method(console, 'error', () => undefined);

    const { result, written } = await run({}, { readError: new Error('boom') });

    assert.deepEqual(result, {
      success: false,
      updatedIds: [],
      unmatchedIds: [],
    });
    assert.equal(written.length, 0);
    assert.equal(
      logged.mock.calls[0].arguments[0],
      'Failed to apply Conductor labels: boom',
    );
  });

  it('stringifies a non-Error failure', async () => {
    const logged = mock.method(console, 'error', () => undefined);

    const { result } = await run(
      {},
      { readError: 'plain' as unknown as Error },
    );

    assert.equal(result.success, false);
    assert.equal(
      logged.mock.calls[0].arguments[0],
      'Failed to apply Conductor labels: plain',
    );
  });
});
