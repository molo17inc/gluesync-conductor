import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SERVICE_ACCOUNT_DIR } from '../kubernetesEnvironment/kubernetesEnvironment';
import {
  KubernetesHttpGet,
  apiServerUrl,
  createKubernetesClient,
  isKubernetesApiError,
} from './kubernetesClient';

const files: Readonly<Record<string, string>> = {
  [`${SERVICE_ACCOUNT_DIR}/token`]: 'the-token\n',
  [`${SERVICE_ACCOUNT_DIR}/ca.crt`]: 'PEM',
};

const readFile =
  (available: Readonly<Record<string, string>> = files) =>
  async (path: string) => {
    if (!(path in available)) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }
    return available[path];
  };

const env = {
  KUBERNETES_SERVICE_HOST: '10.96.0.1',
  KUBERNETES_SERVICE_PORT: '6443',
};

const build = (
  answer: Awaited<ReturnType<KubernetesHttpGet>> | Error,
  overrides: Parameters<typeof createKubernetesClient>[0] = {},
) => {
  const requests: Parameters<KubernetesHttpGet>[0][] = [];
  const client = createKubernetesClient({
    env,
    namespace: 'kit',
    readFile: readFile(),
    httpGet: async request => {
      requests.push(request);
      if (answer instanceof Error) {
        throw answer;
      }
      return answer;
    },
    ...overrides,
  });

  return { client, requests };
};

const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as Error & { statusCode?: number; path?: string };
  }
  return assert.fail('expected a rejection');
};

describe('kubernetesClient', () => {
  it('GETs the API server with the service account token and the cluster CA', async () => {
    const { client, requests } = build({
      statusCode: 200,
      body: '{"items":[{"a":1}]}',
    });

    assert.deepEqual(await client.get('/api/v1/namespaces/kit/pods'), {
      items: [{ a: 1 }],
    });
    assert.deepEqual(requests, [
      {
        url: 'https://10.96.0.1:6443/api/v1/namespaces/kit/pods',
        token: 'the-token',
        ca: 'PEM',
        timeoutMs: 10_000,
      },
    ]);
    assert.equal(client.namespace, 'kit');
  });

  it('reads the token on every call, as the kubelet rotates it', async () => {
    const tokens = ['first', 'second'];
    const { client, requests } = build(
      { statusCode: 200, body: '{}' },
      {
        readFile: async path =>
          path.endsWith('/token') ? (tokens.shift() as string) : 'PEM',
      },
    );

    await client.get('/version');
    await client.get('/version');

    assert.deepEqual(
      requests.map(({ token }) => token),
      ['first', 'second'],
    );
  });

  it('goes on without a CA file', async () => {
    const { client, requests } = build(
      { statusCode: 200, body: '{}' },
      { readFile: readFile({ [`${SERVICE_ACCOUNT_DIR}/token`]: 't' }) },
    );

    await client.get('/version');

    assert.equal(requests[0].ca, undefined);
  });

  it('rejects with the status and the message of the API, and points at the Role on 403', async () => {
    const { client } = build({
      statusCode: 403,
      body: JSON.stringify({
        kind: 'Status',
        message: 'statefulsets.apps is forbidden',
      }),
    });

    const error = await rejection(client.get('/apis/apps/v1/x'));

    assert.equal(isKubernetesApiError(error), true);
    assert.equal(error.statusCode, 403);
    assert.equal(error.path, '/apis/apps/v1/x');
    assert.match(error.message, /answered 403 to GET \/apis\/apps\/v1\/x/);
    assert.match(error.message, /statefulsets\.apps is forbidden/);
    assert.match(error.message, /kubernetes-mode\.md/);
  });

  it('keeps a 404 body that is not JSON as the message', async () => {
    const { client } = build({ statusCode: 404, body: 'not found' });

    const error = await rejection(client.get('/nope'));

    assert.equal(error.statusCode, 404);
    assert.match(error.message, /not found$/);
  });

  it('rejects as an API error when the server cannot be reached', async () => {
    const { client } = build(new Error('connect ECONNREFUSED 10.96.0.1:6443'));

    const error = await rejection(client.get('/version'));

    assert.equal(isKubernetesApiError(error), true);
    assert.equal(error.statusCode, undefined);
    assert.match(error.message, /GET \/version failed: connect ECONNREFUSED/);
  });

  it('rejects as an API error when the token is not mounted', async () => {
    const { client, requests } = build(
      { statusCode: 200, body: '{}' },
      { readFile: readFile({}) },
    );

    const error = await rejection(client.get('/version'));

    assert.equal(isKubernetesApiError(error), true);
    assert.match(error.message, /serviceaccount\/token/);
    assert.deepEqual(requests, []);
  });

  it('rejects a 200 whose body is not JSON', async () => {
    const { client } = build({ statusCode: 200, body: '<html>' });

    assert.match((await rejection(client.get('/version'))).message, /not JSON/);
  });

  it('builds the API server address from the pod environment', () => {
    assert.equal(apiServerUrl(env), 'https://10.96.0.1:6443');
    assert.equal(
      apiServerUrl({ KUBERNETES_SERVICE_HOST: 'fd00::1' }),
      'https://[fd00::1]:443',
    );
    assert.throws(() => apiServerUrl({}), /KUBERNETES_SERVICE_HOST is not set/);
  });

  it('is not an API error for anything else', () => {
    assert.equal(isKubernetesApiError(new Error('x')), false);
    assert.equal(isKubernetesApiError(null), false);
  });
});
