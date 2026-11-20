import assert from 'node:assert/strict';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import fastify, { type FastifyPluginAsync } from 'fastify';

import fakeKubernetesClient, {
  apiError,
  buildWorkload,
  chartCluster,
} from '../../../testing/fakeKubernetesClient';
import kubernetesStubs, {
  untouchableDocker,
} from '../../../testing/kubernetesStubs';
import loadWithStubs from '../../../testing/loadWithStubs';
import { ImageNotPublishedError } from '../../../helpers/agentInfo/agentInfo.errors';
import { KubernetesClient } from '../../../helpers/kubernetes/kubernetes.model';

const helpers = path.resolve(__dirname, '../../../helpers');

// What the backoffice publishes per short image name
const published: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'core-hub': { latestVersionGA: '2.3.2.0', latestVersionBeta: '2.4.0.1' },
  chronos: { latestVersionGA: '0.0.72' },
  conductor: { latestVersionGA: '0.14.4' },
  grafana: { latestVersionGA: '13.0.12.dashboard1' },
  prometheus: { latestVersionGA: '3.15.1' },
};

// Short image names the backoffice was asked about
const asked: string[] = [];

beforeEach(() => {
  asked.length = 0;
});

// The real route (and its response schema) over the real handler, with only
// the backoffice stubbed: the catalog code is the one compose mode runs
const versionOf = async (
  id: string,
  client: KubernetesClient = fakeKubernetesClient(chartCluster()),
  channel = '/ga',
) => {
  const handler = loadWithStubs<{ default: unknown }>(
    path.resolve(__dirname, './getServiceVersion'),
    {
      ...kubernetesStubs(client),
      [`${helpers}/agentInfo/agentInfo`]: {
        default: async (imageName: string) => {
          asked.push(imageName);
          if (!(imageName in published)) {
            throw new ImageNotPublishedError(imageName);
          }
          return published[imageName];
        },
      },
      [`${helpers}/fetchChangelogInfo/fetchChangelogInfo`]: {
        default: async () => ({ id: 'x', notes: 'changes' }),
      },
    },
  ).default;
  const routes = loadWithStubs<{ default: FastifyPluginAsync }>(
    path.resolve(__dirname, '../../../routes/services'),
    { [path.resolve(__dirname, './getServiceVersion')]: { default: handler } },
  );
  const { docker, uses } = untouchableDocker();
  const app = fastify();
  app.decorate('docker', docker);
  await app.register(routes.default);
  await app.ready();

  const res = await app.inject({
    method: 'GET',
    url: `/services/${id}/version${channel}`,
  });
  await app.close();

  assert.deepEqual(uses, []);

  return res;
};

describe('GET /services/:id/version in kubernetes mode', () => {
  it('reports the image tag of the workload as the current version and the catalog as the latest', async () => {
    const res = await versionOf('gluesync-chronos');

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().data, {
      currentVersion: '0.0.72',
      latestVersionGA: '0.0.72',
      mandatoryUpdate: false,
      servicesToUpdate: [],
      updateBlocked: false,
      changelogData: { notes: 'changes' },
    });
    assert.deepEqual(asked, ['chronos']);
  });

  it('answers under the Docker id, and the channels of the catalog', async () => {
    const res = await versionOf('gluesync-core-hub', undefined, '/beta');

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.currentVersion, '2.3.1.4');
    assert.equal(res.json().data.latestVersionGA, '2.3.2.0');
    assert.equal(res.json().data.latestVersionBeta, '2.4.0.1');
  });

  it('defaults to the ga channel', async () => {
    const res = await versionOf('gluesync-core-hub', undefined, '');

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.latestVersionGA, '2.3.2.0');
  });

  it('lists with Core Hub the third-party services and modules that are behind', async () => {
    const res = await versionOf('gluesync-core-hub');

    // Grafana runs 13.0.11.dashboard3 and the catalog has 13.0.12.dashboard1;
    // Chronos and Prometheus are current, and no Conductor workload is there
    assert.deepEqual(res.json().data.servicesToUpdate, ['grafana']);
    assert.equal(res.json().data.mandatoryUpdate, true);
  });

  it('finds the Conductor workload by its Docker id', async () => {
    const cluster = chartCluster();
    const conductor = buildWorkload('prod-gluesync-conductor', {
      image: 'molo17/gluesync-conductor:0.14.3',
    });
    const res = await versionOf(
      'gluesync-core-hub',
      fakeKubernetesClient({
        ...cluster,
        deployments: [...cluster.deployments, conductor],
      }),
    );

    assert.deepEqual(res.json().data.servicesToUpdate, [
      'gluesync-conductor',
      'grafana',
    ]);
  });

  it('strips a tag suffix as compose mode does', async () => {
    const res = await versionOf('grafana');

    assert.equal(res.json().data.currentVersion, '13.0.11.dashboard3');
    assert.equal(res.json().data.latestVersionGA, '13.0.12.dashboard1');
  });

  it('answers 404 for an id that is not in the namespace', async () => {
    const res = await versionOf('gluesync-gluesync-core-hub');

    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json(), {
      success: false,
      error:
        'Service gluesync-gluesync-core-hub not found in namespace gluesync',
    });
    assert.deepEqual(asked, []);
  });

  it('answers 404 for a workload whose image the backoffice does not publish', async () => {
    const stray = buildWorkload('stray', {
      release: '',
      image: 'busybox:1.36',
    });
    const res = await versionOf(
      'stray',
      fakeKubernetesClient({ deployments: [stray] }),
    );

    assert.equal(res.statusCode, 404);
    assert.match(res.json().error, /^Service stray: /);
  });

  it('answers 503 when the Kubernetes API refuses the list', async () => {
    const forbidden = '/api/v1/namespaces/gluesync/pods';
    const res = await versionOf(
      'gluesync-core-hub',
      fakeKubernetesClient({
        paths: { [forbidden]: apiError(403, forbidden) },
      }),
    );

    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error, 'Kubernetes API unavailable');
  });
});
