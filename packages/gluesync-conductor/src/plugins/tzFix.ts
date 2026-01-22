import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { findIana } from 'windows-iana';

type TzFixOptions = Readonly<{
  envVarName?: string; // default: "TZ"
  fallbackIana?: string; // optional, e.g. "UTC"
  log?: boolean; // default: true
}>;

const looksLikeIana = (tz: string): boolean => tz.includes('/');

const tzFixPlugin = async (
  fastify: Readonly<FastifyInstance>,
  opts: TzFixOptions,
): Promise<void> => {
  const { envVarName = 'TZ', fallbackIana, log = true } = opts;

  const tz = process.env[envVarName];
  const isWin = process.platform === 'win32';

  if (!isWin) {
    if (log) fastify.log.debug({ tz }, '[tz-fix] non-windows: no action');
    return;
  }

  if (!tz) {
    if (log) fastify.log.debug('[tz-fix] windows: TZ not set, no action');
    return;
  }

  if (looksLikeIana(tz)) {
    if (log)
      fastify.log.debug({ tz }, '[tz-fix] windows: already IANA, no action');
    return;
  }

  try {
    const candidates = findIana(tz);
    const mapped = candidates?.[0];

    if (mapped) {
      // This plugin intentionally mutates process.env (process-level config).
      // eslint-disable-next-line functional/immutable-data
      process.env[envVarName] = mapped;

      if (log) {
        fastify.log.info(
          { from: tz, to: mapped },
          '[tz-fix] windows TZ normalized',
        );
      }
      return;
    }

    if (fallbackIana) {
      // eslint-disable-next-line functional/immutable-data
      process.env[envVarName] = fallbackIana;

      if (log) {
        fastify.log.warn(
          { from: tz, to: fallbackIana },
          '[tz-fix] mapping missing; using fallback',
        );
      }
      return;
    }

    if (log) {
      fastify.log.warn({ tz }, '[tz-fix] mapping missing; keeping original TZ');
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    if (fallbackIana) {
      // eslint-disable-next-line functional/immutable-data
      process.env[envVarName] = fallbackIana;

      if (log) {
        fastify.log.warn(
          { from: tz, to: fallbackIana, err: message },
          '[tz-fix] error; using fallback',
        );
      }
      return;
    }

    if (log) {
      fastify.log.warn(
        { tz, err: message },
        '[tz-fix] error; keeping original TZ',
      );
    }
  }
};

export default fp(tzFixPlugin, {
  name: 'tz-fix',
  encapsulate: false,
});
