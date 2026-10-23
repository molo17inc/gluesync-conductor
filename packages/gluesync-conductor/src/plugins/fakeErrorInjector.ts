import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import buildDiagnosis from '../diagnosis/buildDiagnosis';
import {
  DIAGNOSIS_CODES,
  Diagnosis,
  DiagnosisCode,
} from '../diagnosis/diagnosis.model';
import { DIAGNOSIS_CATALOG } from '../diagnosis/diagnosisCatalog';
import { getLogger } from '../utils/logger';

/**
 * DEBUG ONLY. Makes the OTA flows fail with a chosen diagnosis, so the UI can
 * be tried without causing a real fault. Nothing happens unless
 * GLUESYNC_FAKE_ERROR is set, and every injected failure is logged as a warning.
 *
 *   GLUESYNC_FAKE_ERROR="update:gluesync-core-hub:MOLO17_HOSTS_BLOCKED,version:*:OTA_SERVICE_DOWN"
 *
 * Each rule is `scope:service:CODE`:
 *   scope    update (POST /containers, action "update") or version (GET /services/:id/version)
 *   service  a service id, or * for every service
 *   CODE     any diagnosis code, such as PROXY_UNREACHABLE or OTA_SERVICE_DOWN
 *
 * `available:service[:version]` instead signals an update that does not exist:
 * the version check reports `version` (default 0.0.0) as the running one, so the
 * UI offers the latest version. Pair it with an `update` rule, or the Update
 * button really recreates the service.
 */
export type FakeErrorScope = 'update' | 'version';

export type FakeErrorRule = Readonly<{
  scope: FakeErrorScope;
  service: string;
  code: DiagnosisCode;
}>;

export type FakeUpdateRule = Readonly<{
  service: string;
  currentVersion: string;
}>;

export type FakeErrorReply = Readonly<{
  statusCode: number;
  body: Readonly<{
    success: false;
    error: string;
    details: string;
    diagnosis: Diagnosis;
  }>;
}>;

type FakeErrorRequest = Readonly<{
  method: string;
  path: string;
  body: unknown;
}>;

const VERSION_PATH = /^\/services\/([^/]+)\/version(?:\/[^/]+)?\/?$/;

const parseRule = (text: string): FakeErrorRule | undefined => {
  const [scope, service, code, ...extra] = text.trim().split(':');

  if (
    extra.length > 0 ||
    (scope !== 'update' && scope !== 'version') ||
    !service ||
    !DIAGNOSIS_CODES.includes(code as DiagnosisCode)
  ) {
    return undefined;
  }

  return { scope, service, code: code as DiagnosisCode };
};

/** Invalid entries are dropped, so a typo never breaks Conductor. */
export const parseFakeErrorRules = (
  raw: string | undefined,
): ReadonlyArray<FakeErrorRule> =>
  (raw ?? '')
    .split(',')
    .filter(entry => entry.trim() !== '')
    .flatMap(entry => {
      const rule = parseRule(entry);
      return rule ? [rule] : [];
    });

const DEFAULT_FAKE_CURRENT_VERSION = '0.0.0';

const parseUpdateRule = (text: string): FakeUpdateRule | undefined => {
  const [scope, service, currentVersion, ...extra] = text.trim().split(':');

  if (extra.length > 0 || scope !== 'available' || !service) {
    return undefined;
  }

  return {
    service,
    currentVersion: currentVersion || DEFAULT_FAKE_CURRENT_VERSION,
  };
};

/** The `available` entries; the failure rules and typos are ignored here. */
export const parseFakeUpdateRules = (
  raw: string | undefined,
): ReadonlyArray<FakeUpdateRule> =>
  (raw ?? '').split(',').flatMap(entry => {
    const rule = parseUpdateRule(entry);
    return rule ? [rule] : [];
  });

/** The `available` rule that applies to this version check, if any. */
export const findFakeUpdate = (
  rules: ReadonlyArray<FakeUpdateRule>,
  { method, path }: Omit<FakeErrorRequest, 'body'>,
): FakeUpdateRule | undefined => {
  const version = method === 'GET' ? VERSION_PATH.exec(path) : null;

  return version
    ? rules.find(
        rule =>
          rule.service === '*' ||
          rule.service === decodeURIComponent(version[1]),
      )
    : undefined;
};

/**
 * The version check reply with the running version replaced, so it differs
 * from the latest one. Anything but a successful reply is left as it is.
 */
export const withFakeUpdate = (payload: unknown, rule: FakeUpdateRule) => {
  const reply = payload as
    | Readonly<{ success?: unknown; data?: unknown }>
    | null
    | undefined;

  if (
    reply?.success !== true ||
    typeof reply.data !== 'object' ||
    reply.data === null
  ) {
    return payload;
  }

  return {
    ...reply,
    data: { ...reply.data, currentVersion: rule.currentVersion },
  };
};

const requestedIds = (body: unknown): ReadonlyArray<string> => {
  const ids =
    typeof body === 'object' && body !== null
      ? (body as { ids?: unknown }).ids
      : undefined;

  return Array.isArray(ids)
    ? ids.filter((id): id is string => typeof id === 'string')
    : [];
};

const isUpdateAction = (body: unknown): boolean =>
  typeof body === 'object' &&
  body !== null &&
  (body as { action?: unknown }).action === 'update';

/** The rule that applies to this request, if any. */
export const findFakeError = (
  rules: ReadonlyArray<FakeErrorRule>,
  { method, path, body }: FakeErrorRequest,
): FakeErrorRule | undefined => {
  if (method === 'POST' && path === '/containers' && isUpdateAction(body)) {
    const ids = requestedIds(body);

    return rules.find(
      rule =>
        rule.scope === 'update' &&
        (rule.service === '*' || ids.includes(rule.service)),
    );
  }

  const version = method === 'GET' ? VERSION_PATH.exec(path) : null;

  if (version) {
    return rules.find(
      rule =>
        rule.scope === 'version' &&
        (rule.service === '*' ||
          rule.service === decodeURIComponent(version[1])),
    );
  }

  return undefined;
};

/** The reply the real code path would send for this diagnosis. */
export const buildFakeErrorReply = (rule: FakeErrorRule): FakeErrorReply => {
  const entry = DIAGNOSIS_CATALOG[rule.code];
  const diagnosis = buildDiagnosis({
    code: rule.code,
    params: entry.exampleParams,
  });
  const details = `${diagnosis.fallback.title} - FAKE error injected by GLUESYNC_FAKE_ERROR (${rule.scope}:${rule.service}:${rule.code})`;

  return {
    // A failing request is never answered with a 2xx.
    statusCode: entry.httpStatus >= 400 ? entry.httpStatus : 502,
    body: {
      success: false,
      error:
        rule.scope === 'update'
          ? 'Failed to do containers action'
          : diagnosis.fallback.title,
      details,
      diagnosis,
    },
  };
};

const fakeErrorInjectorPlugin = async (
  fastify: Readonly<FastifyInstance>,
): Promise<void> => {
  const logger = getLogger();
  const rules = parseFakeErrorRules(process.env.GLUESYNC_FAKE_ERROR);
  const updateRules = parseFakeUpdateRules(process.env.GLUESYNC_FAKE_ERROR);

  logger.warn(
    { rules, updateRules },
    '[fake-error] GLUESYNC_FAKE_ERROR is set: OTA failures and updates are being FAKED. Unset it for normal operation.',
  );

  fastify.addHook('preSerialization', async (req, _reply, payload) => {
    const rule = findFakeUpdate(updateRules, {
      method: req.method,
      path: req.url.split('?')[0],
    });

    if (!rule) {
      return payload;
    }

    logger.warn({ rule }, '[fake-error] signalling a fake available update');

    return withFakeUpdate(payload, rule);
  });

  fastify.addHook('preHandler', async (req, reply) => {
    const rule = findFakeError(rules, {
      method: req.method,
      path: req.url.split('?')[0],
      body: req.body,
    });

    if (!rule) {
      return undefined;
    }

    logger.warn({ rule }, '[fake-error] injecting a fake failure');

    const { statusCode, body } = buildFakeErrorReply(rule);

    return reply.code(statusCode).send(body);
  });
};

export default fp(fakeErrorInjectorPlugin, {
  name: 'fake-error-injector',
  encapsulate: false,
});
