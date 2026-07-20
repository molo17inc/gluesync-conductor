import axios, { type AxiosInstance, AxiosError } from 'axios';
import * as https from 'https';

import { type CurrentUser, createIntrospectionError } from './types';
import { UserRole, parseRole } from './userRole';
import { getGluesyncSdkClient } from '../gluesyncSdkClient';
import { getLogger } from '../utils/logger';

// eslint-disable-next-line functional/no-mixed-types
interface IntrospectOptions {
  readonly cookieHeader: string | undefined;
  readonly authorizationHeader: string | undefined;
}

// eslint-disable-next-line functional/no-mixed-types
interface IntrospectorConfig {
  readonly corehubUrlProvider: () => string | null;
  readonly cacheTtlSeconds?: number;
  readonly timeoutMs?: number;
  readonly verifySsl?: boolean;
}

// eslint-disable-next-line functional/no-mixed-types
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

  // eslint-disable-next-line functional/no-let
  let cache: ReadonlyMap<string, CacheEntry> = new Map();
  // eslint-disable-next-line functional/no-let
  let client: AxiosInstance | null = null;

  const getClient = (): AxiosInstance => {
    if (client) {
      return client;
    }
    const created = axios.create({
      timeout: timeoutMs,
      httpsAgent: verifySsl
        ? undefined
        : new https.Agent({ rejectUnauthorized: false }),
    });
    // eslint-disable-next-line functional/immutable-data
    client = created;
    return created;
  };

  const getCached = (key: string): CurrentUser | null => {
    const entry = cache.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= Date.now() / 1000) {
      // eslint-disable-next-line functional/immutable-data
      const newCache = new Map(cache);
      newCache.delete(key);
      cache = newCache;
      return null;
    }
    return entry.user;
  };

  const putCached = (key: string, user: CurrentUser): void => {
    const expiresAt = Date.now() / 1000 + cacheTtl;
    // eslint-disable-next-line functional/immutable-data
    const newCache = new Map(cache);
    newCache.set(key, { user, expiresAt });
    cache = newCache;
  };

  const introspect = async (
    opts: Readonly<IntrospectOptions>,
  ): Promise<CurrentUser | null> => {
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
      throw createIntrospectionError(
        'CoreHub URL not yet discovered; auth cannot be verified',
      );
    }

    const url = base.replace(/\/+$/, '') + AUTH_ME_PATH;
    // eslint-disable-next-line functional/immutable-data, dot-notation
    const headers: Record<string, string> = {};
    if (opts.authorizationHeader) {
      // eslint-disable-next-line functional/immutable-data
      headers.Authorization = opts.authorizationHeader;
    }
    if (opts.cookieHeader) {
      // eslint-disable-next-line functional/immutable-data
      headers.Cookie = opts.cookieHeader;
    }

    const httpClient = getClient();
    // eslint-disable-next-line functional/no-let
    let status: number;
    // eslint-disable-next-line functional/no-let, @typescript-eslint/no-explicit-any
    let body: any;
    try {
      const response = await httpClient.get(url, { headers });
      status = response.status;
      body = response.data;
    } catch (error: unknown) {
      const axiosError = error as AxiosError;
      if (axiosError.response) {
        status = axiosError.response.status;
        body = axiosError.response.data;
      } else {
        const logger = getLogger();
        logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'Conductor auth introspection failed: CoreHub /auth/me unreachable',
        );
        throw createIntrospectionError(
          `CoreHub /auth/me unreachable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (status === 401 || status === 403) {
      return null;
    }
    if (status >= 500) {
      throw createIntrospectionError(`CoreHub /auth/me returned ${status}`);
    }
    if (status !== 200) {
      throw createIntrospectionError(
        `CoreHub /auth/me returned unexpected status ${status}`,
      );
    }

    const username: string | undefined = body?.username;
    const roleStr: string | undefined = body?.role;
    const role: UserRole | null = parseRole(roleStr);
    if (!username || role === null) {
      throw createIntrospectionError(
        `CoreHub /auth/me response missing username/role (role=${roleStr ?? 'undefined'})`,
      );
    }

    const user: CurrentUser = { username, role };
    putCached(cacheKey, user);
    return user;
  };

  const invalidate = (): void => {
    cache = new Map();
  };

  return { introspect, invalidate };
};

export type Introspector = ReturnType<typeof createIntrospector>;

// eslint-disable-next-line functional/no-let
let singleton: Introspector | null = null;

export const getIntrospector = (): Introspector => {
  if (singleton === null) {
    // eslint-disable-next-line no-use-before-define
    singleton = buildDefaultIntrospector();
  }
  return singleton;
};

export const setIntrospector = (
  // eslint-disable-next-line functional/prefer-immutable-types
  introspector: Introspector | null,
): void => {
  singleton = introspector;
};

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
