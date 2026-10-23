import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import type { RawComposeFile } from '../../models/composeFile.model';
import loadWithStubs from '../../testing/loadWithStubs';
import type { AgentInfoResponse } from '../agentInfo/agentInfo.model';
import type { CanUpdateContainers } from './canUpdateContainers.model';

const here = (p: string): string => path.resolve(__dirname, p);

const info = (ga: string, alpha = `${ga}-alpha`): AgentInfoResponse => ({
  availableAlpha: true,
  availableBeta: true,
  availableGA: true,
  latestVersionAlpha: alpha,
  latestVersionBeta: `${ga}-beta`,
  latestVersionGA: ga,
});

type Backoffice = Record<string, AgentInfoResponse | Error | string>;

const originalWindows = process.env.IS_WINDOWS;
afterEach(() => {
  if (originalWindows === undefined) {
    delete process.env.IS_WINDOWS;
  } else {
    process.env.IS_WINDOWS = originalWindows;
  }
});

const load = (backoffice: Backoffice) => {
  const fetched: string[] = [];
  const canUpdate = loadWithStubs<{ default: CanUpdateContainers }>(
    here('./canUpdateContainers'),
    {
      [here('../agentInfo/agentInfo')]: {
        default: async (name: string) => {
          fetched.push(name);
          const result = backoffice[name];
          if (result === undefined) {
            throw new Error(`unknown ${name}`);
          }
          if (result instanceof Error) {
            throw result;
          }
          if (typeof result === 'string') {
            throw result;
          }
          return result;
        },
      },
    },
  ).default;
  return { canUpdate, fetched };
};

const compose = (
  services: Record<string, { image: string; labels?: unknown }>,
): RawComposeFile => ({ services }) as unknown as RawComposeFile;

const types = (type: string) => [`com.molo17.conductor.type=${type}`];

describe('canUpdateContainers', () => {
  it('succeeds when agents and core-hub share a version and lists modules', async () => {
    const { canUpdate, fetched } = load({
      'core-hub': info('2.3.0'),
      mysql: info('2.3.0'),
      grafana: info('9.1.0'),
    });
    const result = await canUpdate(
      ['agent1', 'grafana'],
      compose({
        agent1: { image: 'repo/gluesync-mysql:2.2.0', labels: types('agent') },
        grafana: {
          image: 'grafana/grafana:9',
          labels: { 'com.molo17.conductor.type': 'module' },
        },
      }),
      'ga',
    );
    assert.deepEqual(result, {
      success: true,
      errors: [],
      message: '',
      data: {
        agentVersion: '2.3.0',
        modules: [{ id: 'grafana', version: '9.1.0' }],
        skipped: [],
      },
    });
    assert.deepEqual(fetched.sort(), ['core-hub', 'grafana', 'mysql']);
  });

  it('reads the version of the requested channel', async () => {
    const { canUpdate } = load({
      'core-hub': info('2.3.0', '2.4.0-a'),
      mysql: info('2.3.0', '2.4.0-a'),
    });
    const result = await canUpdate(
      ['agent1'],
      compose({
        agent1: { image: 'gluesync-mysql:1', labels: types('agent') },
      }),
      'alpha',
    );
    assert.equal(result.data?.agentVersion, '2.4.0-a');
  });

  it('has a null agent version when there are only modules and no core-hub version', async () => {
    const { canUpdate } = load({
      'core-hub': { ...info(''), latestVersionGA: '' },
      chronos: info('0.2.0'),
    });
    const result = await canUpdate(
      ['chronos'],
      compose({
        chronos: { image: 'chronos:0.1', labels: types('module') },
      }),
      'ga',
    );
    assert.equal(result.success, true);
    assert.equal(result.data?.agentVersion, null);
    assert.deepEqual(result.data?.modules, [
      { id: 'chronos', version: '0.2.0' },
    ]);
  });

  it('fails with the versions involved when agents and core-hub disagree', async () => {
    const { canUpdate } = load({
      'core-hub': info('2.3.1'),
      mysql: info('2.3.0'),
    });
    const result = await canUpdate(
      ['agent1'],
      compose({
        agent1: { image: 'gluesync-mysql:1', labels: types('agent') },
      }),
      'ga',
    );
    const message =
      'Agent versions mismatch (including core-hub): agent1 2.3.0, core-hub (latest) 2.3.1';
    assert.deepEqual(result, { success: false, errors: [message], message });
  });

  it('reports none for a missing version in a mismatch', async () => {
    const { canUpdate } = load({
      'core-hub': info('2.3.1'),
      mysql: {
        ...info('x'),
        latestVersionGA: undefined,
      } as unknown as AgentInfoResponse,
    });
    const result = await canUpdate(
      ['agent1'],
      compose({
        agent1: { image: 'gluesync-mysql:1', labels: types('agent') },
      }),
      'ga',
    );
    assert.equal(
      result.message,
      'Agent versions mismatch (including core-hub): agent1 none, core-hub (latest) 2.3.1',
    );
  });

  it('fails when the core-hub version cannot be fetched', async () => {
    const { canUpdate } = load({
      mysql: info('2.3.0'),
    });
    await assert.rejects(
      canUpdate(
        ['agent1'],
        compose({
          agent1: { image: 'gluesync-mysql:1', labels: types('agent') },
        }),
        'ga',
      ),
      /Could not get the latest core-hub version from the backoffice: unknown core-hub/,
    );
  });

  it('stringifies non-Error rejections', async () => {
    const { canUpdate } = load({ mysql: info('2.3.0'), 'core-hub': 'boom' });
    await assert.rejects(
      canUpdate(
        ['agent1'],
        compose({
          agent1: { image: 'gluesync-mysql:1', labels: types('agent') },
        }),
        'ga',
      ),
      /backoffice: boom$/,
    );
  });

  it('blocks the update when an agent cannot be looked up', async () => {
    const { canUpdate } = load({
      'core-hub': info('2.3.0'),
      mysql: new Error('503'),
      grafana: info('9.1.0'),
    });
    const result = await canUpdate(
      ['agent1', 'grafana'],
      compose({
        agent1: { image: 'gluesync-mysql:1', labels: types('agent') },
        grafana: { image: 'grafana:9', labels: types('module') },
      }),
      'ga',
    );
    const message =
      'Could not get the latest version of agent1 from the backoffice: 503';
    assert.deepEqual(result, { success: false, errors: [message], message });
  });

  it('blocks the update when a core-hub service cannot be looked up', async () => {
    const { canUpdate } = load({
      'core-hub': new Error('down'),
    });
    await assert.rejects(
      canUpdate(
        ['hub'],
        compose({
          hub: { image: 'gluesync-core-hub:1', labels: types('core-hub') },
        }),
        'ga',
      ),
      /Could not get the latest core-hub version/,
    );
  });

  it('blocks on unknown services and joins every blocking reason', async () => {
    const { canUpdate } = load({
      'core-hub': info('2.3.0'),
      mysql: new Error('503'),
    });
    const result = await canUpdate(
      ['agent1', 'ghost'],
      compose({
        agent1: { image: 'gluesync-mysql:1', labels: types('agent') },
      }),
      'ga',
    );
    assert.equal(result.success, false);
    assert.deepEqual(result.errors, [
      'Could not get the latest version of agent1 from the backoffice: 503',
      'Service ghost not found',
    ]);
    assert.equal(result.message, result.errors.join('\n'));
  });

  it('skips a module that cannot be looked up and keeps updating the rest', async () => {
    const { canUpdate } = load({
      'core-hub': info('2.3.0'),
      mysql: info('2.3.0'),
      grafana: info('9.1.0'),
      chronos: new Error('404'),
      redis: 'gone',
    });
    const result = await canUpdate(
      ['agent1', 'grafana', 'chronos', 'cache'],
      compose({
        agent1: { image: 'gluesync-mysql:1', labels: types('agent') },
        grafana: { image: 'grafana:9', labels: types('module') },
        chronos: { image: 'chronos:1', labels: types('module') },
        cache: { image: 'redis:7' },
      }),
      'ga',
    );
    assert.equal(result.success, true);
    assert.deepEqual(result.data?.modules, [
      { id: 'grafana', version: '9.1.0' },
    ]);
    assert.deepEqual(result.data?.skipped, [
      {
        id: 'chronos',
        reason:
          'Could not get the latest version of chronos from the backoffice: 404',
      },
      {
        id: 'cache',
        reason:
          'Could not get the latest version of cache from the backoffice: gone',
      },
    ]);
  });

  it('looks third-party Windows images up by their LTSC year', async () => {
    process.env.IS_WINDOWS = 'TRUE';
    const { canUpdate, fetched } = load({
      'core-hub': info('2.3.0'),
      'mssql-win-2022': info('16.0'),
      'mssql-win-2019': info('15.0'),
      other: info('1.0'),
      mongo: info('7.0'),
    });
    const result = await canUpdate(
      ['a', 'b', 'c', 'd'],
      compose({
        a: { image: 'mssql:ltsc2022', labels: types('third-party') },
        b: { image: 'mssql:LTSC2019', labels: types('third-party') },
        c: { image: 'other:1809', labels: types('third-party') },
        d: { image: 'mongo:ltsc2022', labels: types('module') },
      }),
      'ga',
    );
    assert.deepEqual(fetched.sort(), [
      'core-hub',
      'mongo',
      'mssql-win-2019',
      'mssql-win-2022',
      'other',
    ]);
    assert.deepEqual(result.data?.modules, [
      { id: 'a', version: '16.0' },
      { id: 'b', version: '15.0' },
      { id: 'c', version: '1.0' },
      { id: 'd', version: '7.0' },
    ]);
  });

  it('does not touch third-party names on Linux', async () => {
    delete process.env.IS_WINDOWS;
    const { canUpdate, fetched } = load({
      'core-hub': info('2.3.0'),
      mssql: info('16.0'),
    });
    await canUpdate(
      ['a'],
      compose({ a: { image: 'mssql:ltsc2022', labels: types('third-party') } }),
      'ga',
    );
    assert.deepEqual(fetched.sort(), ['core-hub', 'mssql']);
  });
});
