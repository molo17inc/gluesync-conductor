/* eslint-disable no-template-curly-in-string -- the `${TAG}` image is an interpolation the stack file keeps as written */
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import fakeSwarmDocker, {
  FakeService,
  buildService,
} from '../../../testing/fakeSwarmDocker';
import loadWithStubs from '../../../testing/loadWithStubs';
import type { ReconcileSelfImage } from './reconcileSelfImage.model';

const here = (p: string): string => path.resolve(__dirname, p);

const ORCHESTRATOR = {
  mode: 'swarm',
  namespace: 'gs',
  selfService: 'gluesync-conductor',
  isManager: true,
} as const;

const load = (
  fileServices: Record<string, unknown>,
  services: ReadonlyArray<FakeService>,
  writeFails = false,
  dockerOptions: Parameters<typeof fakeSwarmDocker>[0] = {},
) => {
  const { docker, calls } = fakeSwarmDocker({ ...dockerOptions, services });
  const written: Array<{ services: Record<string, unknown> }> = [];

  const reconcile = loadWithStubs<{ default: ReconcileSelfImage }>(
    here('./reconcileSelfImage'),
    {
      [here('../../composeFile/readComposeFile/readComposeFile')]: {
        readComposeFile: async () => ({ version: '3', services: fileServices }),
      },
      [here('../../composeFile/writeComposeFile/writeComposeFile')]: {
        default: async (compose: { services: Record<string, unknown> }) => {
          if (writeFails) {
            throw new Error('read-only file system');
          }
          written.push(compose);
        },
      },
    },
  ).default;

  return { reconcile, docker, calls, written };
};

const FILE_SERVICES = {
  'gluesync-conductor': {
    image: 'molo17/gluesync-conductor:0.2.5',
    labels: ['a=b'],
  },
  'core-hub': { image: 'molo17/gluesync-core-hub:2.3.1' },
};

const rolledBack = (image: string) =>
  buildService('gluesync-conductor', {
    image: `${image}@sha256:0123456789abcdef`,
    state: 'rollback_completed',
    message: 'rollback completed',
  });

const startedRollback = (image: string, state: string) =>
  buildService('gluesync-conductor', {
    image: `${image}@sha256:0123456789abcdef`,
    state,
    message: 'rollback',
  });

describe('reconcileSelfImage', () => {
  it('fixes the stack file while the rollback has only started, from the image of its own container', async () => {
    // The service spec still names the image that was rolled back
    const { reconcile, docker, written } = load(
      FILE_SERVICES,
      [startedRollback('molo17/gluesync-conductor:0.2.5', 'rollback_started')],
      false,
      { selfImage: 'molo17/gluesync-conductor:0.2.4@sha256:0123456789abcdef' },
    );

    assert.equal(await reconcile(docker, ORCHESTRATOR), 'reconciled');
    assert.deepEqual(written, [
      {
        version: '3',
        services: {
          ...FILE_SERVICES,
          'gluesync-conductor': {
            ...FILE_SERVICES['gluesync-conductor'],
            image: 'molo17/gluesync-conductor:0.2.4',
          },
        },
      },
    ]);
  });

  it('treats every rollback state as a rollback', async () => {
    const states = [
      'rollback_started',
      'rollback_paused',
      'rollback_completed',
    ];

    await Promise.all(
      states.map(async state => {
        const { reconcile, docker, written } = load(
          FILE_SERVICES,
          [startedRollback('molo17/gluesync-conductor:0.2.5', state)],
          false,
          { selfImage: 'molo17/gluesync-conductor:0.2.4' },
        );

        assert.equal(
          await reconcile(docker, ORCHESTRATOR),
          'reconciled',
          state,
        );
        assert.equal(written.length, 1, state);
      }),
    );
  });

  it('trusts the own container over the service spec', async () => {
    const { reconcile, docker, written } = load(
      FILE_SERVICES,
      [rolledBack('molo17/gluesync-conductor:0.2.5')],
      false,
      { selfImage: 'molo17/gluesync-conductor:0.2.4' },
    );

    assert.equal(await reconcile(docker, ORCHESTRATOR), 'reconciled');
    assert.equal(
      (written[0].services['gluesync-conductor'] as { image: string }).image,
      'molo17/gluesync-conductor:0.2.4',
    );
  });

  it('falls back to the image of the service when its own container cannot be inspected', async () => {
    const failing = load(
      FILE_SERVICES,
      [rolledBack('molo17/gluesync-conductor:0.2.4')],
      false,
      { selfInspectFails: true },
    );
    const unknown = load(FILE_SERVICES, [
      rolledBack('molo17/gluesync-conductor:0.2.4'),
    ]);

    assert.equal(
      await failing.reconcile(failing.docker, ORCHESTRATOR),
      'reconciled',
    );
    assert.equal(
      await unknown.reconcile(unknown.docker, ORCHESTRATOR),
      'reconciled',
    );
    assert.equal(failing.written.length, 1);
    assert.equal(unknown.written.length, 1);
  });

  it('puts the image the service rolled back to into the stack file, touching nothing else', async () => {
    const { reconcile, docker, calls, written } = load(FILE_SERVICES, [
      rolledBack('molo17/gluesync-conductor:0.2.4'),
    ]);

    assert.equal(await reconcile(docker, ORCHESTRATOR), 'reconciled');
    assert.deepEqual(written, [
      {
        version: '3',
        services: {
          ...FILE_SERVICES,
          'gluesync-conductor': {
            ...FILE_SERVICES['gluesync-conductor'],
            image: 'molo17/gluesync-conductor:0.2.4',
          },
        },
      },
    ]);
    assert.deepEqual(calls.updates, []);
  });

  it('writes nothing when the stack file already names the image the service runs', async () => {
    const { reconcile, docker, written } = load(FILE_SERVICES, [
      rolledBack('molo17/gluesync-conductor:0.2.5'),
    ]);

    assert.equal(await reconcile(docker, ORCHESTRATOR), 'in-sync');
    assert.deepEqual(written, []);
  });

  it('does nothing unless the last update was rolled back', async () => {
    const states = [undefined, 'completed', 'updating', 'paused'];

    await Promise.all(
      states.map(async state => {
        const { reconcile, docker, written } = load(FILE_SERVICES, [
          buildService('gluesync-conductor', {
            image: 'molo17/gluesync-conductor:0.2.4',
            state,
          }),
        ]);

        assert.equal(await reconcile(docker, ORCHESTRATOR), 'no-rollback');
        assert.deepEqual(written, [], String(state));
      }),
    );
  });

  it('leaves an image written as a variable alone', async () => {
    const { reconcile, docker, written } = load(
      {
        'gluesync-conductor': { image: 'molo17/gluesync-conductor:${TAG}' },
      },
      [rolledBack('molo17/gluesync-conductor:0.2.4')],
    );

    assert.equal(await reconcile(docker, ORCHESTRATOR), 'skipped');
    assert.deepEqual(written, []);
  });

  it('skips when the service or its stack file entry is missing', async () => {
    const noService = load(FILE_SERVICES, []);
    const noEntry = load({ 'core-hub': FILE_SERVICES['core-hub'] }, [
      rolledBack('molo17/gluesync-conductor:0.2.4'),
    ]);

    assert.equal(
      await noService.reconcile(noService.docker, ORCHESTRATOR),
      'skipped',
    );
    assert.equal(
      await noEntry.reconcile(noEntry.docker, ORCHESTRATOR),
      'skipped',
    );
    assert.deepEqual(noEntry.written, []);
  });

  it('never throws, so a failed write cannot stop the startup', async () => {
    const { reconcile, docker } = load(
      FILE_SERVICES,
      [rolledBack('molo17/gluesync-conductor:0.2.4')],
      true,
    );

    assert.equal(await reconcile(docker, ORCHESTRATOR), 'skipped');
  });
});
