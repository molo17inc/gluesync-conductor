import { readFileSync } from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';
import https from 'node:https';

import { KubernetesClient } from '../kubernetes.model';
import {
  readNamespace,
  serviceAccountFile,
} from '../kubernetesEnvironment/kubernetesEnvironment';

export const KUBERNETES_API_ERROR = 'KUBERNETES_API_ERROR';

export type KubernetesApiError = Error &
  Readonly<{
    code: typeof KUBERNETES_API_ERROR;
    // HTTP status of the API server, `undefined` when it did not answer
    statusCode?: number;
    path: string;
  }>;

export const isKubernetesApiError = (
  error: unknown,
): error is KubernetesApiError =>
  (error as { code?: unknown } | null)?.code === KUBERNETES_API_ERROR;

const apiError = (
  message: string,
  path: string,
  statusCode?: number,
): KubernetesApiError =>
  Object.assign(new Error(message), {
    code: KUBERNETES_API_ERROR,
    statusCode,
    path,
  } as const);

export type KubernetesHttpResponse = Readonly<{
  statusCode: number;
  body: string;
}>;

export type KubernetesHttpGet = (
  request: Readonly<{
    url: string;
    token: string;
    // PEM of the cluster CA; the system CAs are used without it
    ca?: string;
    timeoutMs: number;
  }>,
) => Promise<KubernetesHttpResponse>;

const httpsGet: KubernetesHttpGet = ({ url, token, ca, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: 'GET',
        ca,
        timeout: timeoutMs,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
      },
      response => {
        const chunks: Buffer[] = [];

        response.on('data', (chunk: Readonly<Buffer>) => {
          // eslint-disable-next-line functional/immutable-data -- collecting the body of one response
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );

    request.on('timeout', () => {
      request.destroy(
        new Error(`the Kubernetes API did not answer within ${timeoutMs} ms`),
      );
    });
    request.on('error', reject);
    request.end();
  });

// eslint-disable-next-line functional/no-mixed-types -- injected dependencies: values and functions together
export type KubernetesClientDeps = Readonly<{
  env: Readonly<NodeJS.ProcessEnv>;
  readFile: (path: string) => Promise<string>;
  httpGet: KubernetesHttpGet;
  timeoutMs: number;
  // Defaults to the namespace of the pod
  namespace: string;
}>;

// An IPv6 address needs brackets in a URL
const hostInUrl = (host: string): string =>
  host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;

/** `https://<KUBERNETES_SERVICE_HOST>:<KUBERNETES_SERVICE_PORT>`, the API server as a pod sees it. */
export const apiServerUrl = (env: Readonly<NodeJS.ProcessEnv>): string => {
  const host = env.KUBERNETES_SERVICE_HOST?.trim();

  if (!host) {
    throw new Error(
      'KUBERNETES_SERVICE_HOST is not set: the Kubernetes API can only be reached from inside a pod',
    );
  }

  return `https://${hostInUrl(host)}:${env.KUBERNETES_SERVICE_PORT?.trim() || '443'}`;
};

const messageOf = (body: string): string => {
  try {
    const { message } = JSON.parse(body) as { message?: unknown };

    return typeof message === 'string' ? message : body;
  } catch {
    return body;
  }
};

const forbiddenHint = (statusCode: number): string =>
  statusCode === 401 || statusCode === 403
    ? ' (check the Role bound to the service account of the Conductor, see docs/kubernetes-mode.md)'
    : '';

/**
 * Read-only client of the Kubernetes API for a process in a pod: the service
 * account token (read on every call, the kubelet rotates it) and the cluster
 * CA come from the mounted service account. No dependency: the Conductor only
 * lists and gets a few objects.
 */
export const createKubernetesClient = (
  overrides: Partial<KubernetesClientDeps> = {},
): KubernetesClient => {
  const env = overrides.env ?? process.env;
  const {
    readFile = (path: string) => readFileAsync(path, 'utf8'),
    httpGet = httpsGet,
    timeoutMs = 10_000,
    // Read once: a pod never changes namespace
    namespace = readNamespace({
      env,
      readFile: path => readFileSync(path, 'utf8'),
    }),
  } = overrides;

  const get = async <T>(path: string): Promise<T> => {
    const response = await (async (): Promise<KubernetesHttpResponse> => {
      try {
        const [token, ca] = await Promise.all([
          readFile(serviceAccountFile('token')),
          // Without the CA file the system CAs decide
          readFile(serviceAccountFile('ca.crt')).catch(() => undefined),
        ]);

        return await httpGet({
          url: `${apiServerUrl(env)}${path}`,
          token: token.trim(),
          ca,
          timeoutMs,
        });
      } catch (error) {
        throw apiError(
          `Kubernetes API request GET ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
          path,
        );
      }
    })();

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw apiError(
        `Kubernetes API answered ${response.statusCode} to GET ${path}: ${messageOf(response.body)}${forbiddenHint(response.statusCode)}`,
        path,
        response.statusCode,
      );
    }

    try {
      return JSON.parse(response.body) as T;
    } catch {
      throw apiError(
        `Kubernetes API answered GET ${path} with a body that is not JSON`,
        path,
        response.statusCode,
      );
    }
  };

  return { namespace, get };
};

const clientCache = new Map<'value', KubernetesClient>();

/** The client of this process, created on first use. */
export const getKubernetesClient = (): KubernetesClient => {
  const cached = clientCache.get('value');

  if (cached) {
    return cached;
  }

  const client = createKubernetesClient();

  clientCache.set('value', client);

  return client;
};
