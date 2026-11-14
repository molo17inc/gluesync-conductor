import axios, { type AxiosInstance } from 'axios';
import * as https from 'node:https';

import { getGluesyncSdkClient } from '../../gluesyncSdkClient';
import {
  resolveCoreHubUrl,
  shouldVerifySsl,
} from '../../security/corehubIntrospect';
import { getLogger } from '../../utils/logger';
import stripTrailingSlashes from '../../utils/stripTrailingSlashes';
import {
  CoreHubPipeline,
  CoreHubPipelinesApi,
  CoreHubPipelinesApiOptions,
} from './coreHubPipelinesApi.model';
import {
  CoreHubApiError,
  CoreHubUnreachableError,
} from './pipelineMaintenance.errors';

const READ_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

const sdkToken = (): string | null => {
  try {
    return getGluesyncSdkClient(getLogger()).token;
  } catch {
    return null;
  }
};

const upstreamText = (data: unknown): string => {
  if (typeof data === 'string') {
    return data.slice(0, 300);
  }
  const body = data as
    | Readonly<{ message?: unknown; exceptionMessage?: unknown }>
    | undefined;
  return [body?.message, body?.exceptionMessage]
    .filter(part => typeof part === 'string' && part !== '')
    .join(' - ');
};

const asApiError = (what: string, error: unknown): Error => {
  if (error instanceof CoreHubUnreachableError) {
    return error;
  }
  if (axios.isAxiosError(error) && error.response) {
    const text = upstreamText(error.response.data);
    const said = text ? ` (${text})` : '';
    return new CoreHubApiError(
      `${what}: Core Hub answered ${error.response.status}${said}`,
      error.response.status,
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new CoreHubUnreachableError(
    `${what}: Core Hub unreachable (${message})`,
  );
};

const asPipeline = (raw: unknown): CoreHubPipeline | null => {
  const p = raw as Readonly<Record<string, unknown>> | null;
  if (!p || typeof p.id !== 'string') {
    return null;
  }
  return {
    id: p.id,
    name: typeof p.name === 'string' ? p.name : undefined,
    // Older Core Hubs may not send it: a pipeline counts as configured then
    configurationCompleted: p.configurationCompleted !== false,
    isInMaintenanceMode: p.isInMaintenanceMode === true,
  };
};

const isActive = (raw: unknown): boolean => {
  const status = raw as Readonly<Record<string, unknown>> | null;
  return status?.isSyncActive === true || status?.isMigrationActive === true;
};

/**
 * The Core Hub REST endpoints the update uses to put pipelines in maintenance
 * mode and back (gluesync-kotlin `corehub/.../server/route/rest/`:
 * `PipelinesRoutes.kt` and `SyncCommandRoutes.kt`, mounted under `/pipelines`).
 * The Conductor authenticates with the token Core Hub gave it in the module
 * handshake (role EXTERNAL_MODULE, which may start and stop replication).
 */
const createCoreHubPipelinesApi = (
  options: CoreHubPipelinesApiOptions = {},
): CoreHubPipelinesApi => {
  const baseUrl = options.baseUrl ?? resolveCoreHubUrl;
  const token = options.token ?? sdkToken;
  const verifySsl = options.verifySsl ?? shouldVerifySsl();
  const client: AxiosInstance = axios.create({
    httpsAgent: verifySsl
      ? undefined
      : new https.Agent({ rejectUnauthorized: false }),
  });

  const target = (path: string) => {
    const base = baseUrl();
    if (!base) {
      throw new CoreHubUnreachableError('Core Hub address not known yet');
    }
    const jwt = token();
    if (!jwt) {
      throw new CoreHubUnreachableError(
        'the Conductor is not connected to Core Hub (no module token)',
      );
    }
    return {
      url: `${stripTrailingSlashes(base)}${path}`,
      headers: { Authorization: `Bearer ${jwt}` },
    };
  };

  const call = async <T>(
    what: string,
    method: 'get' | 'post',
    path: string,
    timeout: number,
  ): Promise<T> => {
    try {
      const { url, headers } = target(path);
      const response =
        method === 'get'
          ? await client.get(url, { headers, timeout })
          : await client.post(url, undefined, { headers, timeout });
      return response.data as T;
    } catch (error) {
      throw asApiError(what, error);
    }
  };

  const id = encodeURIComponent;
  const readTimeout = options.timeoutMs ?? READ_TIMEOUT_MS;
  const commandTimeout = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;

  return {
    listPipelines: async () => {
      const data = await call<unknown>(
        'listing the pipelines',
        'get',
        '/pipelines',
        readTimeout,
      );
      if (!Array.isArray(data)) {
        throw new CoreHubApiError(
          'listing the pipelines: Core Hub did not answer with a list',
          200,
        );
      }
      return data
        .map(asPipeline)
        .filter((p): p is CoreHubPipeline => p !== null);
    },
    isRunning: async pipelineId => {
      const data = await call<unknown>(
        `reading the status of pipeline ${pipelineId}`,
        'get',
        `/pipelines/${id(pipelineId)}/entities-status`,
        readTimeout,
      );
      return Array.isArray(data) && data.some(isActive);
    },
    enterMaintenance: async pipelineId => {
      await call(
        `putting pipeline ${pipelineId} in maintenance mode`,
        'post',
        `/pipelines/${id(pipelineId)}/commands/maintenance/enter`,
        commandTimeout,
      );
    },
    exitMaintenance: async pipelineId => {
      await call(
        `taking pipeline ${pipelineId} out of maintenance mode`,
        'post',
        `/pipelines/${id(pipelineId)}/commands/maintenance/exit`,
        commandTimeout,
      );
    },
  };
};

export default createCoreHubPipelinesApi;
