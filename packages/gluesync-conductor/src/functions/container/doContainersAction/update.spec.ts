/* eslint-disable functional/immutable-data, functional/prefer-immutable-types, functional/no-let */
// The fixtures swap axios' adapter, set environment variables and record calls, which is inherently imperative.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import axios, {
  AxiosAdapter,
  AxiosError,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from 'axios';
import type Docker from 'dockerode';
import { parse } from 'yaml';

import canUpdateContainers from '../../../helpers/canUpdateContainers/canUpdateContainers';
import checkModuleUpdate from '../../../helpers/checkModuleUpdate/checkModuleUpdate';
import getCurrentVersion from '../../../helpers/getCurrentVersion/getCurrentVersion';
import { RawComposeFile } from '../../../models/composeFile.model';
import {
  disableUpdateMode,
  isUpdateMode,
} from '../../../plugins/apiBlockerAsUpdating';
import updateConductorOnly from './handleUpdate/updateConductorOnly';
import updateNormalBulk from './handleUpdate/updateNormalBulk';

// A missing beta/alpha falls back to the GA version; null means the channel has none.
type ChannelVersions = Readonly<{
  ga: string | null;
  beta?: string | null;
  alpha?: string | null;
}>;

// What the fake backoffice answers per short image name: versions, or an HTTP status to fail with.
type Catalog = Readonly<Record<string, ChannelVersions | number>>;

const VERSION_URL =
  /^https:\/\/api\.backoffice\.molo17\.com\/agent\/([^/]+)\/version$/;

const CONDUCTOR = 'gluesync-conductor';
const CORE_HUB = 'gluesync-core-hub';
const AGENT = 'gluesync-mssql-ct';
const CHRONOS = 'gluesync-chronos';

const service = (image: string, type: string) => ({
  image,
  labels: [`com.molo17.conductor.type=${type}`],
});

// Shaped like the debug stack: Core Hub and agents share one version, modules have their own.
const COMPOSE: RawComposeFile = {
  services: {
    [CORE_HUB]: service('molo17/gluesync-core-hub:2.2.11.10', 'core-hub'),
    [AGENT]: service('molo17/gluesync-mssql-ct:2.2.11.10', 'agent'),
    [CHRONOS]: service('molo17/gluesync-chronos:0.2.4', 'module'),
    [CONDUCTOR]: service('molo17/gluesync-conductor:3.1.0', 'module'),
    grafana: service('molo17/grafana:13.0.2.dashboard3', 'third-party'),
  },
};

const withServices = (
  services: RawComposeFile['services'],
): RawComposeFile => ({
  ...COMPOSE,
  services: { ...COMPOSE.services, ...services },
});

const CATALOG: Catalog = {
  'core-hub': { ga: '2.2.11.11' },
  'mssql-ct': { ga: '2.2.11.11' },
  chronos: { ga: '0.2.5' },
  conductor: { ga: '3.2.0' },
  grafana: { ga: '13.0.2.dashboard3' },
};

let catalog: Catalog = CATALOG;
let requests: string[] = [];

const reply = (
  config: InternalAxiosRequestConfig,
  status: number,
  data: unknown,
): Promise<AxiosResponse> => {
  const response: AxiosResponse = {
    data,
    status,
    statusText: String(status),
    headers: {},
    config,
    request: {},
  };

  return (config.validateStatus ?? (() => true))(status)
    ? Promise.resolve(response)
    : Promise.reject(
        new AxiosError(
          `Request failed with status code ${status}`,
          AxiosError.ERR_BAD_RESPONSE,
          config,
          {},
          response,
        ),
      );
};

// Answers backoffice version lookups in-process, so no test reaches the network.
const fakeBackoffice: AxiosAdapter = config => {
  const url = config.url ?? '';
  requests.push(url);

  const entry = catalog[VERSION_URL.exec(url)?.[1] ?? ''];

  if (entry === undefined) {
    return reply(config, 404, { message: 'Not found' });
  }

  if (typeof entry === 'number') {
    return reply(config, entry, { message: 'Unavailable' });
  }

  const beta = 'beta' in entry ? entry.beta : entry.ga;
  const alpha = 'alpha' in entry ? entry.alpha : entry.ga;

  return reply(config, 200, {
    availableGA: entry.ga !== null,
    availableBeta: beta !== null,
    availableAlpha: alpha !== null,
    latestVersionGA: entry.ga,
    latestVersionBeta: beta,
    latestVersionAlpha: alpha,
  });
};

// Short image names the backoffice was asked about, in order.
const asked = (): ReadonlyArray<string> =>
  requests.map(url => VERSION_URL.exec(url)?.[1] ?? url);

// Docker with one running container per listed service, on the given image.
const dockerRunning = (images: Readonly<Record<string, string>>): Docker =>
  ({
    ping: async () => 'OK',
    listContainers: async (options: { filters: { label: string[] } }) => {
      const id = options.filters.label[0].split('=')[1];
      return images[id] ? [{ Id: id, State: 'running' }] : [];
    },
    getContainer: (id: string) => ({
      inspect: async () => ({ Config: { Image: images[id] } }),
    }),
  }) as unknown as Docker;

const dockerUnreachable = (): Docker => {
  const refused = () =>
    Promise.reject(
      Object.assign(new Error('connect ECONNREFUSED /var/run/docker.sock'), {
        code: 'ECONNREFUSED',
      }),
    );

  return { ping: refused, listContainers: refused } as unknown as Docker;
};

// Stands in for the docker compose update; fails like docker-compose does (`{ exitCode, out, err }`).
const recordingAction = (failing: ReadonlyArray<string> = []) => {
  const calls: string[] = [];

  const action = (id: string): Promise<string> => {
    calls.push(id);
    return failing.includes(id)
      ? // eslint-disable-next-line prefer-promise-reject-errors -- the real failure is not an Error either
        Promise.reject({ exitCode: 1, out: '', err: `pull ${id} failed` })
      : Promise.resolve(`${id} updated`);
  };

  return { calls, action };
};

const ENV_KEYS = [
  'PROJECT_CWD',
  'IS_WINDOWS',
  'CORE_HUB_NAME',
  'DOCKER_HOST',
  'CONDUCTOR_DOCKER_WAIT_MS',
] as const;
const savedEnv = Object.fromEntries(
  ENV_KEYS.map(key => [key, process.env[key]]),
);
const realAdapter = axios.defaults.adapter;
const COMPOSE_FILE = process.env.DKR_COMPOSE_FILE || 'docker-compose.yml';

let projectDir = '';

const composePath = () => join(projectDir, COMPOSE_FILE);

const writtenCompose = async (): Promise<RawComposeFile> =>
  parse(await readFile(composePath(), 'utf8'));

const imagesOf = (compose: RawComposeFile): Record<string, string> =>
  Object.fromEntries(
    Object.entries(compose.services ?? {}).map(([id, svc]) => [id, svc.image]),
  );

const assertNothingWritten = () =>
  assert.rejects(readFile(composePath(), 'utf8'), { code: 'ENOENT' });

beforeEach(async () => {
  catalog = CATALOG;
  requests = [];
  axios.defaults.adapter = fakeBackoffice;

  // Compose writes resolve against PROJECT_CWD, which Yarn points at the repository root.
  projectDir = await mkdtemp(join(tmpdir(), 'conductor-update-'));
  process.env.PROJECT_CWD = projectDir;
  // A failed update rolls back with a real `docker compose up`: point it at a
  // socket that does not exist, so no test ever touches the local Docker daemon.
  process.env.DOCKER_HOST = `unix://${join(projectDir, 'no-docker.sock')}`;
  delete process.env.IS_WINDOWS;
  delete process.env.CORE_HUB_NAME;
  // ... and the wait for that Docker to come back must not take a minute.
  process.env.CONDUCTOR_DOCKER_WAIT_MS = '200';
});

afterEach(async () => {
  disableUpdateMode();
  axios.defaults.adapter = realAdapter;
  ENV_KEYS.forEach(key => {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  });
  await rm(projectDir, { recursive: true, force: true });
});

describe('checkModuleUpdate', () => {
  it('asks the backoffice by short image name and offers the GA version', async () => {
    const info = await checkModuleUpdate(
      dockerRunning({ [CONDUCTOR]: 'molo17/gluesync-conductor:3.1.0' }),
      COMPOSE,
      'ga',
      CONDUCTOR,
    );

    assert.deepEqual(info, {
      needsUpdate: true,
      id: CONDUCTOR,
      availableVersion: '3.2.0',
    });
    assert.deepEqual(asked(), ['conductor']);
  });

  it('offers the version of the requested channel', async () => {
    catalog = { conductor: { ga: '3.2.0', beta: '3.3.0', alpha: '3.4.0' } };
    const docker = dockerRunning({
      [CONDUCTOR]: 'molo17/gluesync-conductor:3.1.0',
    });

    const versions = await Promise.all(
      (['ga', 'beta', 'alpha'] as const).map(channel =>
        checkModuleUpdate(docker, COMPOSE, channel, CONDUCTOR).then(
          info => info?.availableVersion,
        ),
      ),
    );

    assert.deepEqual(versions, ['3.2.0', '3.3.0', '3.4.0']);
  });

  it('compares with the running container, not the compose file', async () => {
    // A previous update rewrote the compose file but the container was never recreated.
    const info = await checkModuleUpdate(
      dockerRunning({ [CONDUCTOR]: 'molo17/gluesync-conductor:3.1.0' }),
      withServices({
        [CONDUCTOR]: service('molo17/gluesync-conductor:3.2.0', 'module'),
      }),
      'ga',
      CONDUCTOR,
    );

    assert.equal(info?.needsUpdate, true);
  });

  it('ignores the platform suffix of the running tag', async () => {
    const info = await checkModuleUpdate(
      dockerRunning({
        [CONDUCTOR]: 'molo17/gluesync-conductor:3.2.0-ltsc2022',
      }),
      COMPOSE,
      'ga',
      CONDUCTOR,
    );

    assert.equal(info?.needsUpdate, false);
  });

  it('offers nothing when the channel has no version', async () => {
    catalog = { conductor: { ga: '3.2.0', beta: null } };

    const info = await checkModuleUpdate(
      dockerRunning({ [CONDUCTOR]: 'molo17/gluesync-conductor:3.1.0' }),
      COMPOSE,
      'beta',
      CONDUCTOR,
    );

    assert.deepEqual(info, {
      needsUpdate: false,
      id: CONDUCTOR,
      availableVersion: null,
    });
  });

  it('returns null for a service the compose file does not have', async () => {
    const info = await checkModuleUpdate(
      dockerRunning({}),
      COMPOSE,
      'ga',
      'gluesync-missing',
    );

    assert.equal(info, null);
    assert.deepEqual(asked(), []);
  });

  it('lets a backoffice failure through after retrying, so the reply can explain it', async () => {
    catalog = { conductor: 503 };

    await assert.rejects(
      checkModuleUpdate(
        dockerRunning({ [CONDUCTOR]: 'molo17/gluesync-conductor:3.1.0' }),
        COMPOSE,
        'ga',
        CONDUCTOR,
      ),
      (error: unknown) =>
        axios.isAxiosError(error) && error.response?.status === 503,
    );
    // One attempt plus three retries.
    assert.equal(requests.length, 4);
  });
});

describe('getCurrentVersion', () => {
  it('falls back to the compose tag when Docker cannot be reached', async () => {
    assert.equal(
      await getCurrentVersion(dockerUnreachable(), COMPOSE, CONDUCTOR, true),
      '3.1.0',
    );
  });

  it('falls back to the compose tag when the container is not running', async () => {
    assert.equal(
      await getCurrentVersion(dockerRunning({}), COMPOSE, CONDUCTOR, true),
      '3.1.0',
    );
  });
});

describe('canUpdateContainers', () => {
  it('gives agents and Core Hub one shared version and each module its own', async () => {
    const result = await canUpdateContainers(
      [CORE_HUB, AGENT, CHRONOS],
      COMPOSE,
      'ga',
    );

    assert.deepEqual(result, {
      success: true,
      errors: [],
      message: '',
      data: {
        agentVersion: '2.2.11.11',
        modules: [{ id: CHRONOS, version: '0.2.5' }],
        skipped: [],
      },
    });
  });

  it('refuses when an agent would land on a different version than Core Hub', async () => {
    catalog = { ...CATALOG, 'mssql-ct': { ga: '2.2.11.12' } };

    const result = await canUpdateContainers([AGENT], COMPOSE, 'ga');

    assert.equal(result.success, false);
    assert.equal(
      result.message,
      'Agent versions mismatch (including core-hub): gluesync-mssql-ct 2.2.11.12, core-hub (latest) 2.2.11.11',
    );
    // Core Hub is checked even when it is not part of the update.
    assert.ok(asked().includes('core-hub'));
  });

  it('reports a service the compose file does not have', async () => {
    const result = await canUpdateContainers(
      ['gluesync-missing'],
      COMPOSE,
      'ga',
    );

    assert.equal(result.success, false);
    assert.equal(result.message, 'Service gluesync-missing not found');
  });

  it('gives a module no version when its channel has none', async () => {
    catalog = { ...CATALOG, chronos: { ga: '0.2.5', beta: null } };

    const result = await canUpdateContainers([CHRONOS], COMPOSE, 'beta');

    assert.deepEqual(result.data?.modules, [{ id: CHRONOS, version: null }]);
  });

  it('on Windows, looks third-party images up under their Windows build', async () => {
    process.env.IS_WINDOWS = 'true';
    catalog = { ...CATALOG, 'traefik-win-2019': { ga: '3.7.5' } };

    const result = await canUpdateContainers(
      ['reverse-proxy'],
      withServices({
        'reverse-proxy': service(
          'molo17/traefik:3.7.4-ltsc2019',
          'third-party',
        ),
      }),
      'ga',
    );

    assert.deepEqual(result.data?.modules, [
      { id: 'reverse-proxy', version: '3.7.5' },
    ]);
    assert.ok(asked().includes('traefik-win-2019'));
  });
});

describe('updateNormalBulk', () => {
  it('moves the services to their new tags and starts with Core Hub', async () => {
    const { calls, action } = recordingAction();

    const { orderedIds, results } = await updateNormalBulk(
      action,
      COMPOSE,
      [AGENT, CHRONOS, CORE_HUB],
      'ga',
      { docker: dockerRunning({}) },
    );

    assert.deepEqual(orderedIds, [CORE_HUB, AGENT, CHRONOS]);
    assert.deepEqual(calls, [CORE_HUB, AGENT, CHRONOS]);
    assert.ok(results.every(result => result.status === 'fulfilled'));
    assert.deepEqual(imagesOf(await writtenCompose()), {
      [CORE_HUB]: 'molo17/gluesync-core-hub:2.2.11.11',
      [AGENT]: 'molo17/gluesync-mssql-ct:2.2.11.11',
      [CHRONOS]: 'molo17/gluesync-chronos:0.2.5',
      [CONDUCTOR]: 'molo17/gluesync-conductor:3.1.0',
      grafana: 'molo17/grafana:13.0.2.dashboard3',
    });
  });

  it('keeps the registry and the platform suffix of a tag', async () => {
    const { action } = recordingAction();

    await updateNormalBulk(
      action,
      withServices({
        [CORE_HUB]: service(
          'registry.example.com/molo17/gluesync-core-hub:2.2.11.10-ltsc2022',
          'core-hub',
        ),
      }),
      [CORE_HUB],
      'ga',
      { docker: dockerRunning({}) },
    );

    assert.equal(
      imagesOf(await writtenCompose())[CORE_HUB],
      'registry.example.com/molo17/gluesync-core-hub:2.2.11.11-ltsc2022',
    );
  });

  it('with no ids, updates every service Conductor manages except itself', async () => {
    const { action } = recordingAction();

    const { orderedIds } = await updateNormalBulk(
      action,
      // A service without Conductor labels was added by hand and is left alone.
      withServices({ sidecar: { image: 'busybox:1.36' } }),
      [],
      'ga',
      { docker: dockerRunning({}) },
    );

    assert.deepEqual(orderedIds, [CORE_HUB, AGENT, CHRONOS, 'grafana']);
    assert.equal(imagesOf(await writtenCompose()).sidecar, 'busybox:1.36');
  });

  it('skips a module whose channel has no version instead of failing', async () => {
    catalog = { ...CATALOG, chronos: { ga: '0.2.5', beta: null } };
    const { calls, action } = recordingAction();

    const { orderedIds } = await updateNormalBulk(
      action,
      COMPOSE,
      [CORE_HUB, CHRONOS],
      'beta',
      { docker: dockerRunning({}) },
    );

    assert.deepEqual(orderedIds, [CORE_HUB]);
    assert.deepEqual(calls, [CORE_HUB]);
    assert.equal(
      imagesOf(await writtenCompose())[CHRONOS],
      'molo17/gluesync-chronos:0.2.4',
    );
  });

  it('changes nothing when an agent and Core Hub disagree', async () => {
    catalog = { ...CATALOG, 'mssql-ct': { ga: '2.2.11.12' } };
    const { calls, action } = recordingAction();

    await assert.rejects(
      updateNormalBulk(action, COMPOSE, [CORE_HUB, AGENT], 'ga', {
        docker: dockerRunning({}),
      }),
      /Agent versions mismatch/,
    );
    assert.deepEqual(calls, []);
    await assertNothingWritten();
  });

  it('reports a failed service without holding back the others', async () => {
    const { action } = recordingAction([AGENT]);

    const { orderedIds, results } = await updateNormalBulk(
      action,
      COMPOSE,
      [CORE_HUB, AGENT, CHRONOS],
      'ga',
      { docker: dockerUnreachable() },
    );

    assert.deepEqual(
      results.map((result, index) => [orderedIds[index], result.status]),
      [
        [CORE_HUB, 'fulfilled'],
        [AGENT, 'rejected'],
        [CHRONOS, 'fulfilled'],
      ],
    );
    // The handler shows `reason.err` to the user: the failure, then the rollback.
    assert.match(
      (results[1] as PromiseRejectedResult).reason.err,
      /^pull gluesync-mssql-ct failed Rollback to molo17\/gluesync-mssql-ct:2\.2\.11\.10 failed: /,
    );
    // The compose file no longer points the failed service at the new image.
    assert.deepEqual(imagesOf(await writtenCompose()), {
      ...imagesOf(COMPOSE),
      [CORE_HUB]: 'molo17/gluesync-core-hub:2.2.11.11',
      [CHRONOS]: 'molo17/gluesync-chronos:0.2.5',
    });
  });
});

describe('updateConductorOnly', () => {
  it('moves Conductor to the new tag and blocks the API until it restarts', async () => {
    const { calls, action } = recordingAction();

    const { id, results } = await updateConductorOnly(
      action,
      { id: CONDUCTOR, availableVersion: '3.2.0' },
      COMPOSE,
    );

    assert.equal(id, CONDUCTOR);
    assert.deepEqual(calls, [CONDUCTOR]);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(isUpdateMode(), true);
    assert.deepEqual(imagesOf(await writtenCompose()), {
      ...imagesOf(COMPOSE),
      [CONDUCTOR]: 'molo17/gluesync-conductor:3.2.0',
    });
  });

  it('keeps the API open when the Conductor update fails', async () => {
    const { action } = recordingAction([CONDUCTOR]);

    const { results } = await updateConductorOnly(
      action,
      { id: CONDUCTOR, availableVersion: '3.2.0' },
      COMPOSE,
    );

    assert.equal(results[0].status, 'rejected');
    assert.equal(isUpdateMode(), false);
  });

  it('refuses without a version to move to', async () => {
    const { calls, action } = recordingAction();

    await assert.rejects(
      updateConductorOnly(
        action,
        { id: CONDUCTOR, availableVersion: null },
        COMPOSE,
      ),
      /No available version for conductor/,
    );
    assert.deepEqual(calls, []);
    await assertNothingWritten();
  });
});
