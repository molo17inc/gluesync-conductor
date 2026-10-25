import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import fakeSwarmDocker, {
  FakeService,
  buildService,
} from '../../../testing/fakeSwarmDocker';
import loadWithStubs from '../../../testing/loadWithStubs';
import type { CreateSwarmActions } from './createSwarmActions.model';

const here = (p: string): string => path.resolve(__dirname, p);

const ORCHESTRATOR = {
  mode: 'swarm',
  namespace: 'gs',
  selfService: 'gluesync-conductor',
  isManager: true,
} as const;

type ConvergeResult = { ok: true } | { ok: false; reason: string };

type Setup = Readonly<{
  services?: ReadonlyArray<FakeService>;
  fileServices?: Record<string, unknown>;
  converged?: ConvergeResult;
  stopped?: ConvergeResult;
  updateErrors?: ReadonlyArray<Error | undefined>;
  pingErrors?: ReadonlyArray<Error>;
  pingDown?: boolean;
}>;

const flush = (): Promise<void> =>
  new Promise(resolve => {
    setImmediate(resolve);
  });

const load = ({
  services = [],
  fileServices = {},
  converged = { ok: true },
  stopped = { ok: true },
  updateErrors,
  pingErrors,
  pingDown,
}: Setup = {}) => {
  const { docker, calls } = fakeSwarmDocker({
    services,
    updateErrors,
    pingErrors,
    pingDown,
  });
  const deploys: unknown[][] = [];
  const written: unknown[] = [];
  const waited: string[] = [];

  const createSwarmActions = loadWithStubs<{ default: CreateSwarmActions }>(
    here('./createSwarmActions'),
    {
      [here('../../composeFile/readComposeFile/readComposeFile')]: {
        readComposeFile: async () => ({ version: '3', services: fileServices }),
      },
      [here('../../composeFile/writeComposeFile/writeComposeFile')]: {
        default: async (compose: unknown) => {
          written.push(compose);
        },
      },
      [here('../../getRootPath/getRootPath')]: {
        default: ({ filename }: { filename: string }) => `/root/${filename}`,
      },
      [here('../stackDeploy/stackDeploy')]: {
        default: async (...args: unknown[]) => {
          deploys.push(args);
          return 'deployed';
        },
      },
      [here('../waitForServiceConverged/waitForServiceConverged')]: {
        default: async (_docker: unknown, name: string) => {
          waited.push(`converged ${name}`);
          return converged;
        },
      },
      [here('../waitForServiceStopped/waitForServiceStopped')]: {
        default: async (_docker: unknown, name: string) => {
          waited.push(`stopped ${name}`);
          return stopped;
        },
      },
      [here('../../../utils/logger')]: {
        getLogger: () => ({ info: () => undefined, error: () => undefined }),
      },
    },
  ).default;

  const actions = createSwarmActions({
    docker,
    orchestrator: ORCHESTRATOR,
    filename: 'stack.yml',
  });

  return { actions, calls, deploys, written, waited };
};

const hub = buildService('gluesync-core-hub', { replicas: 0 });
const conductor = buildService('gluesync-conductor');

describe('createSwarmActions', () => {
  describe('start', () => {
    it('scales to the replicas of the stack file and waits', async () => {
      const { actions, calls, deploys, waited } = load({
        services: [hub],
        fileServices: { 'gluesync-core-hub': { deploy: { replicas: 2 } } },
      });

      assert.equal(
        await actions.start('gluesync-core-hub'),
        'Service gluesync-core-hub started.',
      );
      assert.deepEqual(calls.updates[0].body.Mode, {
        Replicated: { Replicas: 2 },
      });
      assert.deepEqual(deploys, []);
      assert.deepEqual(waited, ['converged gs_gluesync-core-hub']);
    });

    it('starts one replica when the stack file does not say', async () => {
      const { actions, calls } = load({
        services: [hub],
        fileServices: { 'gluesync-core-hub': { image: 'x:1' } },
      });

      await actions.start('gluesync-core-hub');

      assert.deepEqual(calls.updates[0].body.Mode, {
        Replicated: { Replicas: 1 },
      });
    });

    it('deploys the stack when the service does not exist yet', async () => {
      const { actions, calls, deploys, waited } = load({
        fileServices: { 'gluesync-new': { image: 'x:1' } },
      });

      await actions.start('gluesync-new');

      assert.deepEqual(deploys, [
        ['gs', '/root/stack.yml', '/opt/gluesync-conductor/root-folder/.env'],
      ]);
      assert.equal(calls.updates.length, 0);
      assert.deepEqual(waited, ['converged gs_gluesync-new']);
    });

    it('fails when the service does not converge', async () => {
      const { actions } = load({
        services: [hub],
        converged: { ok: false, reason: 'gs_gluesync-core-hub did not start' },
      });

      await assert.rejects(actions.start('gluesync-core-hub'), /did not start/);
    });
  });

  describe('stop', () => {
    it('scales to zero and waits for the tasks to be gone', async () => {
      const { actions, calls, waited } = load({ services: [conductor, hub] });

      assert.equal(
        await actions.stop('gluesync-core-hub'),
        'Service gluesync-core-hub stopped.',
      );
      assert.deepEqual(calls.updates[0].body.Mode, {
        Replicated: { Replicas: 0 },
      });
      assert.deepEqual(waited, ['stopped gs_gluesync-core-hub']);
    });

    it('fails when the tasks keep running', async () => {
      const { actions } = load({
        services: [hub],
        stopped: { ok: false, reason: 'still has 1 running task(s)' },
      });

      await assert.rejects(actions.stop('gluesync-core-hub'), /still has 1/);
    });
  });

  describe('restart and kill', () => {
    it('force updates the service and waits', async () => {
      const { actions, calls, waited } = load({
        services: [buildService('gluesync-core-hub', { forceUpdate: 4 })],
      });

      assert.equal(
        await actions.restart('gluesync-core-hub'),
        'Service gluesync-core-hub restarted.',
      );
      await actions.kill('gluesync-core-hub');
      assert.equal(calls.updates[0].body.TaskTemplate.ForceUpdate, 5);
      assert.equal(calls.updates.length, 2);
      assert.equal(waited.length, 2);
    });

    it('reports a restart that did not converge', async () => {
      const { actions } = load({
        services: [hub],
        converged: { ok: false, reason: 'gs_gluesync-core-hub update paused' },
      });

      await assert.rejects(actions.restart('gluesync-core-hub'), /paused/);
    });

    it('leaves the restart of the conductor itself until after the reply', async () => {
      const { actions, calls, waited } = load({ services: [conductor] });

      assert.equal(
        await actions.restart('gluesync-conductor'),
        'Conductor gluesync-conductor restart initiated.',
      );
      assert.equal(calls.updates.length, 0);
      await flush();
      await flush();
      assert.equal(calls.updates.length, 1);
      assert.equal(calls.updates[0].body.TaskTemplate.ForceUpdate, 1);
      assert.deepEqual(waited, [], 'it cannot wait for its own replacement');
    });
  });

  it('pull does nothing', async () => {
    const { actions, calls } = load();

    assert.match(await actions.pull('gluesync-core-hub'), /pulls the image/);
    assert.equal(calls.updates.length, 0);
  });

  it('remove deletes the service', async () => {
    const { actions, calls } = load({ services: [hub] });

    await actions.remove('gluesync-core-hub');

    assert.deepEqual(calls.removed, ['gs_gluesync-core-hub']);
  });

  describe('undeploy', () => {
    const fileServices = {
      'gluesync-core-hub': { image: 'hub:1' },
      keep: { image: 'keep:1' },
    };

    it('removes the service and its entry in the stack file', async () => {
      const { actions, calls, written } = load({
        services: [hub],
        fileServices,
      });

      assert.equal(
        await actions.undeploy('gluesync-core-hub'),
        'Agent gluesync-core-hub undeployed successfully',
      );
      assert.deepEqual(calls.removed, ['gs_gluesync-core-hub']);
      assert.deepEqual(written, [
        { version: '3', services: { keep: { image: 'keep:1' } } },
      ]);
    });

    it('still edits the file for a service that was never started', async () => {
      const { actions, calls, written } = load({ fileServices });

      await actions.undeploy('gluesync-core-hub');

      assert.deepEqual(calls.removed, []);
      assert.equal(written.length, 1);
    });

    it('says so when the stack file does not have the service', async () => {
      const { actions, written } = load({ services: [hub] });

      assert.equal(
        await actions.undeploy('gluesync-core-hub'),
        'Agent gluesync-core-hub not found',
      );
      assert.deepEqual(written, []);
    });
  });

  describe('update', () => {
    const fileServices = {
      'gluesync-core-hub': { image: 'molo17/gluesync-core-hub:2.4.0' },
      'gluesync-conductor': { image: 'molo17/gluesync-conductor:2.4.0' },
    };
    const current = (extra: Parameters<typeof buildService>[1] = {}) =>
      buildService('gluesync-core-hub', {
        image: 'molo17/gluesync-core-hub:2.3.0',
        previousSpec: { Name: 'gs_gluesync-core-hub' },
        ...extra,
      });

    it('sets the image of the stack file and waits for the rollout', async () => {
      const { actions, calls, waited } = load({
        services: [current()],
        fileServices,
      });

      assert.equal(
        await actions.update('gluesync-core-hub'),
        'Agent gluesync-core-hub updated and restarted.',
      );
      assert.equal(calls.updates.length, 1);
      assert.equal(
        calls.updates[0].body.TaskTemplate.ContainerSpec.Image,
        'molo17/gluesync-core-hub:2.4.0',
      );
      assert.equal(
        calls.updates[0].body.UpdateConfig.FailureAction,
        'rollback',
      );
      assert.deepEqual(waited, ['converged gs_gluesync-core-hub']);
    });

    it('rolls the service back when the new version does not converge', async () => {
      const { actions, calls } = load({
        services: [current()],
        fileServices,
        converged: { ok: false, reason: 'gs_gluesync-core-hub not stable' },
      });

      await assert.rejects(
        actions.update('gluesync-core-hub'),
        /not stable\. Rolled the service back to molo17\/gluesync-core-hub:2\.3\.0\./,
      );
      assert.equal(calls.updates.length, 2);
      assert.deepEqual(calls.updates[1].query.rollback, 'previous');
    });

    it('does not roll back what Swarm already rolled back', async () => {
      const { actions, calls } = load({
        services: [current({ state: 'rollback_completed' })],
        fileServices,
        converged: { ok: false, reason: 'update rollback_completed' },
      });

      await assert.rejects(
        actions.update('gluesync-core-hub'),
        /Swarm rolled the service back to molo17\/gluesync-core-hub:2\.3\.0/,
      );
      assert.equal(calls.updates.length, 1, 'rolling back again would undo it');
    });

    it('reports a rollback that failed', async () => {
      const { actions } = load({
        services: [buildService('gluesync-core-hub')],
        fileServices,
        converged: { ok: false, reason: 'not stable' },
      });

      await assert.rejects(
        actions.update('gluesync-core-hub'),
        /Rollback to .* failed: .* has no previous version/,
      );
    });

    it('needs an image in the stack file', async () => {
      const { actions, calls } = load({ services: [current()] });

      await assert.rejects(
        actions.update('gluesync-core-hub'),
        /has no image in the stack file/,
      );
      assert.equal(calls.updates.length, 0);
    });

    it('leaves a service already on the image of the stack file alone', async () => {
      const { actions, calls, waited } = load({
        services: [
          current({ image: 'molo17/gluesync-core-hub:2.4.0@sha256:abc' }),
        ],
        fileServices,
      });

      assert.equal(
        await actions.update('gluesync-core-hub'),
        'Service gluesync-core-hub is already on molo17/gluesync-core-hub:2.4.0.',
      );
      assert.equal(calls.updates.length, 0);
      assert.deepEqual(waited, []);
    });

    it('rolls nothing out when no service of the stack has a newer version', async () => {
      const ids = ['gluesync-core-hub', 'traefik', 'prometheus'];
      const { actions, calls, waited } = load({
        services: [
          ...ids.map(id =>
            buildService(id, { image: `molo17/${id}:1.0@sha256:abc` }),
          ),
          buildService('gluesync-conductor', {
            image: 'molo17/gluesync-conductor:2.4.0',
          }),
        ],
        fileServices: {
          ...Object.fromEntries(
            ids.map(id => [id, { image: `molo17/${id}:1.0` }]),
          ),
          'gluesync-conductor': { image: 'molo17/gluesync-conductor:2.4.0' },
        },
      });

      const messages = await Promise.all(
        [...ids, 'gluesync-conductor'].map(actions.update),
      );

      await flush();
      await flush();
      assert.ok(messages.every(message => /is already on/.test(message)));
      assert.equal(calls.updates.length, 0);
      assert.deepEqual(waited, []);
    });

    it('does not update the conductor already on the image of the stack file', async () => {
      const { actions, calls } = load({
        services: [
          buildService('gluesync-conductor', {
            image: 'molo17/gluesync-conductor:2.4.0',
          }),
        ],
        fileServices,
      });

      assert.equal(
        await actions.update('gluesync-conductor'),
        'Service gluesync-conductor is already on molo17/gluesync-conductor:2.4.0.',
      );
      await flush();
      await flush();
      assert.equal(calls.updates.length, 0);
    });

    it('updates the conductor after the reply and does not wait', async () => {
      const { actions, calls, waited } = load({
        services: [conductor],
        fileServices,
      });

      assert.equal(
        await actions.update('gluesync-conductor'),
        'Conductor gluesync-conductor updated and restarted.',
      );
      assert.equal(calls.updates.length, 0, 'the reply goes out first');
      await flush();
      await flush();
      assert.equal(calls.updates.length, 1);
      assert.equal(
        calls.updates[0].body.TaskTemplate.ContainerSpec.Image,
        'molo17/gluesync-conductor:2.4.0',
      );
      assert.deepEqual(waited, []);
    });
  });
  describe('a Docker outage', () => {
    const fileServices = {
      'gluesync-core-hub': { image: 'molo17/gluesync-core-hub:2.4.0' },
    };
    const old = buildService('gluesync-core-hub', {
      image: 'molo17/gluesync-core-hub:2.3.0',
      previousSpec: { Name: 'gs_gluesync-core-hub' },
    });
    const refused = (): Error =>
      Object.assign(new Error('connect ECONNREFUSED /var/run/docker.sock'), {
        code: 'ECONNREFUSED',
      });

    afterEach(() => {
      delete process.env.CONDUCTOR_DOCKER_WAIT_MS;
    });

    it('retries an update that met a dropped connection, once Docker answers', async () => {
      const { actions, calls } = load({
        services: [old],
        fileServices,
        updateErrors: [refused()],
      });

      assert.equal(
        await actions.update('gluesync-core-hub'),
        'Agent gluesync-core-hub updated and restarted.',
      );
      assert.equal(calls.updates.length, 1);
    });

    it('does not retry a real error', async () => {
      const { actions, calls } = load({
        services: [old],
        fileServices,
        // A second attempt would succeed: only a retry could hide this error
        updateErrors: [new Error('invalid reference format')],
      });

      await assert.rejects(
        actions.update('gluesync-core-hub'),
        /invalid reference format/,
      );
      assert.equal(calls.updates.length, 0);
    });

    it('fails before touching anything when Docker is down at the start', async () => {
      process.env.CONDUCTOR_DOCKER_WAIT_MS = '300';
      const { actions, calls } = load({
        services: [old],
        fileServices,
        pingDown: true,
      });

      await assert.rejects(
        actions.update('gluesync-core-hub'),
        /Docker daemon not ready within 300ms/,
      );
      assert.equal(calls.updates.length, 0);
    });

    it('leaves the rollback to the final restore when Docker is gone for it', async () => {
      const { actions } = load({
        services: [old],
        fileServices,
        converged: { ok: false, reason: 'gs_gluesync-core-hub not stable' },
        // The update lands, then the rollback meets a Docker that stays down
        updateErrors: [undefined, refused(), refused(), refused()],
      });

      await assert.rejects(
        actions.update('gluesync-core-hub'),
        /not stable\. Docker was unavailable for the rollback to molo17\/gluesync-core-hub:2\.3\.0\./,
      );
    });

    it('retries a restart that met a dropped connection', async () => {
      const { actions, calls } = load({
        services: [old],
        updateErrors: [refused()],
      });

      await actions.restart('gluesync-core-hub');
      assert.equal(calls.updates.length, 1);
    });
  });
});
