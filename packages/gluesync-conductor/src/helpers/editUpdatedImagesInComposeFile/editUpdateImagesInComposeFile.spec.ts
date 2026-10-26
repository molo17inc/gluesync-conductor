/* eslint-disable no-template-curly-in-string -- Compose interpolations are the subject of this spec */
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import loadWithStubs from '../../testing/loadWithStubs';
import { EditUpdateImagesInComposeFile } from './editUpdateImagesInComposeFile.model';

const load = () => {
  const written: unknown[] = [];
  const edit = loadWithStubs<{ default: EditUpdateImagesInComposeFile }>(
    path.resolve(__dirname, './editUpdateImagesInComposeFile'),
    {
      [path.resolve(
        __dirname,
        '../composeFile/writeComposeFile/writeComposeFile',
      )]: {
        default: async (json: unknown) => {
          written.push(json);
        },
      },
    },
  ).default;

  return { edit, written };
};

const labels = ['com.molo17.conductor.type=module'];

describe('editUpdateImagesInComposeFile', () => {
  it('rewrites a literal tag and keeps its suffix', async () => {
    const { edit, written } = load();

    await edit(
      ['grafana'],
      {
        services: { grafana: { image: 'molo17/grafana:11-dashboard', labels } },
      },
      { agentVersion: null, modules: [{ id: 'grafana', version: '12' }] },
    );

    assert.deepEqual(written, [
      {
        services: {
          grafana: { image: 'molo17/grafana:12-dashboard', labels },
        },
      },
    ]);
  });

  it('leaves an interpolated tag exactly as the customer wrote it', async () => {
    const { edit, written } = load();
    const grafana = { image: 'molo17/grafana:${TAG:-11}', labels };

    await edit(
      ['grafana'],
      { services: { grafana } },
      { agentVersion: null, modules: [{ id: 'grafana', version: '12' }] },
    );

    assert.deepEqual(written, [{ services: { grafana } }]);
  });

  describe('in swarm mode, with no type label in the stack file', () => {
    const versions = {
      agentVersion: '2.3.1',
      modules: [{ id: 'grafana', version: '13.0.2' }],
    };

    it('gives an agent and Core Hub the agent version, found from their image', async () => {
      const { edit, written } = load();

      await edit(
        ['mssql-agent', 'gluesync-core-hub', 'grafana'],
        {
          services: {
            'mssql-agent': { image: 'molo17/gluesync-mssql-cdc:2.3.0' },
            'gluesync-core-hub': { image: 'molo17/gluesync-core-hub:2.3.0' },
            grafana: { image: 'molo17/grafana:13.0.1' },
          },
        },
        versions,
        { swarm: true },
      );

      assert.deepEqual(written, [
        {
          services: {
            'mssql-agent': { image: 'molo17/gluesync-mssql-cdc:2.3.1' },
            'gluesync-core-hub': { image: 'molo17/gluesync-core-hub:2.3.1' },
            grafana: { image: 'molo17/grafana:13.0.2' },
          },
        },
      ]);
    });

    it('reads the type from deploy.labels', async () => {
      const { edit, written } = load();

      await edit(
        ['db'],
        {
          services: {
            db: {
              image: 'acme/db:1',
              deploy: { labels: ['com.molo17.conductor.type=agent'] },
            },
          },
        },
        versions,
        { swarm: true },
      );

      assert.equal((written[0] as any).services.db.image, 'acme/db:2.3.1');
    });

    it('does not guess on compose, where the label is what counts', async () => {
      const { edit } = load();

      await assert.rejects(
        edit(
          ['mssql-agent'],
          {
            services: {
              'mssql-agent': { image: 'molo17/gluesync-mssql-cdc:2.3.0' },
            },
          },
          versions,
        ),
        /No version available for service mssql-agent/,
      );
    });
  });
});
