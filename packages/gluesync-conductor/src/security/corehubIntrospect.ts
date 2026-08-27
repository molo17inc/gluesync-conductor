import axios, { type AxiosInstance, AxiosError } from 'axios';
import * as https from 'https';

import { type CurrentUser } from './types';
import { UserRole, parseRole } from './userRole';
import { getGluesyncSdkClient } from '../gluesyncSdkClient';
import { getLogger } from '../utils/logger';

interface IntrospectOptions {
  readonly cookieHeader: string | undefined;
  readonly authorizationHeader: string | undefined;
}

type IntrospectorConfig = Readonly<{
  corehubUrlProvider: () => string | null;
}> &
  Readonly<{
    cacheTtlSeconds?: number;
    timeoutMs?: number;
    verifySsl?: boolean;
  }>;

interface CacheEntry {
  readonly user: CurrentUser;
  readonly expiresAt: number;
}

const AUTH_ME_PATH = '/authentication/me';
const AUTH_COOKIE_NAME = 'gs-auth';

const envInt = (name: string, defaultValue: number): number => {
  const raw = process.env[name];
  if (!raw) {
    return defaultValue;
  }
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
};

const shouldVerifySsl = (): boolean => {
  const skip =
    process.env.SSL_SKIP_VERIFY?.toLowerCase() === 'true' ||
    process.env.SKIP_TLS_VERIFICATION?.toLowerCase() === 'true';
  return !skip;
};

const extractCookieValue = (
  cookieHeader: string,
  name: string,
): string | null => {
  const parts = cookieHeader.split(';');
  const found = parts.find(part => {
    const trimmed = part.trim();
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) {
      return false;
    }
    return trimmed.slice(0, eqIdx).trim() === name;
  });
  if (!found) {
    return null;
  }
  const trimmed = found.trim();
  const eqIdx = trimmed.indexOf('=');
  const value = trimmed.slice(eqIdx + 1).trim();
  return value || null;
};

const createCacheKey = (opts: Readonly<IntrospectOptions>): string | null => {
  if (opts.authorizationHeader) {
    const token = opts.authorizationHeader.trim();
    if (token) {
      return `authz:${token}`;
    }
  }
  if (opts.cookieHeader) {
    const value = extractCookieValue(opts.cookieHeader, AUTH_COOKIE_NAME);
    if (value) {
      return `cookie:${value}`;
    }
  }
  return null;
};

export const createIntrospector = (config: Readonly<IntrospectorConfig>) => {
  const cacheTtl =
    config.cacheTtlSeconds ?? envInt('CONDUCTOR_AUTH_CACHE_TTL', 30);
  const timeoutMs =
    config.timeoutMs ?? envInt('CONDUCTOR_AUTH_TIMEOUT_MS', 5000);
  const verifySsl = config.verifySsl ?? shouldVerifySsl();

  const cache = new Map<string, CacheEntry>();
  const clientMap = new Map<string, AxiosInstance>();
  const CLIENT_KEY = 'default';

  const getClient = (): AxiosInstance => {
    const existing = clientMap.get(CLIENT_KEY);
    if (existing) {
      return existing;
    }
    const created = axios.create({
      timeout: timeoutMs,
      httpsAgent: verifySsl
        ? undefined
        : new https.Agent({ rejectUnauthorized: false }),
    });
    clientMap.set(CLIENT_KEY, created);
    return created;
  };

  const getCached = (key: string): CurrentUser | null => {
    const entry = cache.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= Date.now() / 1000) {
      cache.delete(key);
      return null;
    }
    return entry.user;
  };

  const putCached = (key: string, user: CurrentUser): void => {
    const expiresAt = Date.now() / 1000 + cacheTtl;
    cache.set(key, { user, expiresAt });
  };

  const introspect = async (
    opts: Readonly<IntrospectOptions>,
  ): Promise<CurrentUser | null> => {
    getLogger().debug(
      {
        hasAuthorization: !!opts.authorizationHeader,
        hasCookie: !!opts.cookieHeader,
      },
      'Conductor auth introspection called',
    );
    const cacheKey = createCacheKey(opts);
    if (cacheKey === null) {
      return null;
    }

    const cached = getCached(cacheKey);
    if (cached !== null) {
      return cached;
    }

    const base = config.corehubUrlProvider();
    if (!base) {
      throw new Error(
        'CoreHub URL not yet discovered; auth cannot be verified',
      );
    }

    const url = base.replace(/\/+$/, '') + AUTH_ME_PATH;
    const headers: Readonly<Record<string, string>> = {
      ...(opts.authorizationHeader
        ? { Authorization: opts.authorizationHeader }
        : {}),
      ...(opts.cookieHeader ? { Cookie: opts.cookieHeader } : {}),
    };

    const httpClient = getClient();
    const { status, body }: { status: number; body: any } = await (async () => {
      try {
        const response = await httpClient.get(url, { headers });
        return { status: response.status, body: response.data };
      } catch (error: unknown) {
        const axiosError = error as AxiosError;
        if (axiosError.response) {
          return {
            status: axiosError.response.status,
            body: axiosError.response.data,
          };
        }
        const logger = getLogger();
        logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'Conductor auth introspection failed: CoreHub /auth/me unreachable',
        );
        throw new Error(
          `CoreHub /auth/me unreachable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();

    if (status === 401 || status === 403) {
      return null;
    }
    if (status >= 500) {
      throw new Error(`CoreHub /auth/me returned ${status}`);
    }
    if (status !== 200) {
      throw new Error(`CoreHub /auth/me returned unexpected status ${status}`);
    }

    const username: string | undefined = body?.username;
    const roleStr: string | undefined = body?.role;
    const role: UserRole | null = parseRole(roleStr);
    if (!username || role === null) {
      throw new Error(
        `CoreHub /auth/me response missing username/role (role=${roleStr ?? 'undefined'})`,
      );
    }

    const user: CurrentUser = { username, role };
    putCached(cacheKey, user);
    return user;
  };

  const invalidate = (): void => {
    cache.clear();
  };

  return { introspect, invalidate };
};

export type Introspector = ReturnType<typeof createIntrospector>;

const buildDefaultIntrospector = (): Introspector => {
  const urlProvider = (): string | null => {
    const override = process.env.CONDUCTOR_COREHUB_URL_OVERRIDE;
    if (override) {
      return override;
    }
    try {
      return getGluesyncSdkClient(getLogger()).coreHubUrl;
    } catch {
      return null;
    }
  };

  return createIntrospector({
    corehubUrlProvider: urlProvider,
    verifySsl: shouldVerifySsl(),
  });
};

const SINGLETON_KEY = 'default';
const singletonMap = new Map<string, Introspector>();

export const getIntrospector = (): Introspector => {
  if (!singletonMap.has(SINGLETON_KEY)) {
    singletonMap.set(SINGLETON_KEY, buildDefaultIntrospector());
  }
  return singletonMap.get(SINGLETON_KEY) as Introspector;
};

export const setIntrospector = (
  introspector: Readonly<Introspector> | null,
): void => {
  if (introspector === null) {
    singletonMap.delete(SINGLETON_KEY);
  } else {
    singletonMap.set(SINGLETON_KEY, introspector);
  }
};
