import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { RawComposeFile } from '../../../../models/composeFile.model';
import loadWithStubs from '../../../../testing/loadWithStubs';
import type { PrepareComposeUpdate } from './prepareComposeUpdate.model';

const here = (p: string): string => path.resolve(__dirname, p);

type CanUpdate = Readonly<{
  success: boolean;
  message: string;
  data?: Readonly<{
    agentVersion: string | null;
    modules: ReadonlyArray<{ id: string; version: string | null }>;
    skipped: ReadonlyArray<{ id: string; reason: string }>;
  }>;
}>;

const load = (canUpdateResult: CanUpdate, allIds: readonly string[] = []) => {
  const checked: Array<readonly string[]> = [];
  const options: unknown[] = [];
  const edited: Array<{ ids: readonly string[]; data: unknown }> = [];
  const prepare = loadWithStubs<{ default: PrepareComposeUpdate }>(
    here('./prepareComposeUpdate'),
    {
      [here('../../../../helpers/canUpdateContainers/canUpdateContainers')]: {
        default: async (
          ids: readonly string[],
          _compose: unknown,
          _channel: unknown,
          canUpdateOptions: unknown,
        ) => {
          checked.push(ids);
          options.push(canUpdateOptions);
          return canUpdateResult;
        },
      },
      [here(
        '../../../../helpers/fetchAllServicesInCompose/fetchAllServicesInCompose',
      )]: { default: () => allIds },
      [here(
        '../../../../helpers/editUpdatedImagesInComposeFile/editUpdateImagesInComposeFile',
      )]: {
        default: async (
          ids: readonly string[],
          _compose: unknown,
          data: unknown,
          editOptions: unknown,
        ) => {
          edited.push({ ids, data });
          options.push(editOptions);
        },
      },
    },
  ).default;
  return { prepare, checked, edited, options };
};

const compose = {
  services: {
    'gluesync-conductor': {
      image: 'c:1',
      labels: ['com.molo17.conductor.type=module'],
    },
    grafana: { image: 'g:1', labels: ['com.molo17.conductor.type=module'] },
    chronos: {
      image: 'ch:1',
      labels: { 'com.molo17.conductor.type': 'module' },
    },
    mysql: { image: 'm:1', labels: ['other=1'] },
    plain: { image: 'p:1' },
  },
} as unknown as RawComposeFile;

const ok = (data: NonNullable<CanUpdate['data']>): CanUpdate => ({
  success: true,
  message: '',
  data,
});

describe('prepareComposeUpdate', () => {
  it('updates the requested services and reports the skipped ones', async () => {
    const data = {
      agentVersion: null,
      modules: [
        { id: 'grafana', version: '9.1' },
        { id: 'chronos', version: null },
        { id: 'redis', version: '7' },
      ],
      skipped: [{ id: 'redis', reason: 'backoffice 404' }],
    };
    const { prepare, checked, edited } = load(ok(data));
    const result = await prepare(
      compose,
      ['grafana', 'chronos', 'redis', 'mysql'],
      'ga',
    );
    assert.deepEqual(result, {
      effectiveIds: ['grafana', 'mysql'],
      skipped: [{ id: 'redis', reason: 'backoffice 404' }],
    });
    assert.deepEqual(checked, [['grafana', 'chronos', 'redis', 'mysql']]);
    assert.deepEqual(edited, [{ ids: ['grafana', 'mysql'], data }]);
  });

  it('updates every labelled service except the conductor when none is requested', async () => {
    const { prepare, checked } = load(
      ok({ agentVersion: null, modules: [], skipped: [] }),
      ['gluesync-conductor', 'grafana', 'chronos', 'mysql', 'plain', 'ghost'],
    );
    const result = await prepare(compose, [], 'ga');
    assert.deepEqual(checked, [['grafana', 'chronos']]);
    assert.deepEqual(result, {
      effectiveIds: ['grafana', 'chronos'],
      skipped: [],
    });
  });

  it('throws the reason when the update cannot go ahead', async () => {
    const { prepare, edited } = load({ success: false, message: 'mismatch' });
    await assert.rejects(
      prepare(compose, ['grafana'], 'ga'),
      /^Error: mismatch$/,
    );
    assert.equal(edited.length, 0);
  });

  it('throws when the check succeeded without data', async () => {
    const { prepare } = load({ success: true, message: 'no data' });
    await assert.rejects(prepare(compose, ['grafana'], 'ga'), /no data/);
  });

  describe('in swarm mode', () => {
    const stack = {
      services: {
        'gluesync-conductor': { image: 'molo17/gluesync-conductor:0.14.0' },
        'gluesync-core-hub': { image: 'molo17/gluesync-core-hub:2.3.0' },
        // Not one label in the stack file: the names and images say what they are
        'gluesync-chronos': { image: 'molo17/gluesync-chronos:0.2.4' },
        grafana: { image: 'molo17/grafana:13.0.1' },
        'mssql-agent': { image: 'molo17/gluesync-mssql-cdc:2.3.0' },
        mine: { image: 'acme/mine:1' },
      },
    } as unknown as RawComposeFile;
    const data = { agentVersion: '2.3.1', modules: [], skipped: [] };

    it('updates every service it can type, except the conductor, when none is requested', async () => {
      const { prepare, checked } = load(
        ok(data),
        Object.keys(stack.services ?? {}),
      );

      const result = await prepare(stack, [], 'ga', { swarm: true });

      assert.deepEqual(checked, [
        ['gluesync-core-hub', 'gluesync-chronos', 'grafana', 'mssql-agent'],
      ]);
      assert.deepEqual(result.effectiveIds, checked[0]);
    });

    it('tells the helpers it is swarm, so they type the same way', async () => {
      const { prepare, options } = load(ok(data));

      await prepare(stack, ['mssql-agent'], 'ga', { swarm: true });

      assert.deepEqual(options, [{ swarm: true }, { swarm: true }]);
    });

    it('keeps the labels as the only source on compose', async () => {
      const { prepare, checked } = load(
        ok(data),
        Object.keys(stack.services ?? {}),
      );

      await prepare(stack, [], 'ga');

      assert.deepEqual(checked, [[]]);
    });
  });
});
