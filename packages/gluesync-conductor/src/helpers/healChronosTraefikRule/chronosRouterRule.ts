import { RawComposeService } from '../../models/composeFile.model';
import toLabelStrings from '../../utils/toLabelStrings';

export const CHRONOS_ROUTER_RULE_KEY = 'traefik.http.routers.chronos.rule';

export const HEALED_CHRONOS_ROUTER_RULE =
  'PathPrefix(`/chronos/`) || PathPrefix(`/chronos/api/`)';

// A standalone `/api/` prefix. This does not match PathPrefix(`/chronos/api/`).
const STANDALONE_API_PREFIX = /PathPrefix\(\s*`\/api\/`\s*\)/;

export const rewriteChronosRouterRuleValue = (value: string): string | null =>
  STANDALONE_API_PREFIX.test(value) ? HEALED_CHRONOS_ROUTER_RULE : null;

export const sanitizeChronosRouterLabels = <T extends Record<string, any>>(
  labels: T,
): T => {
  const current = labels[CHRONOS_ROUTER_RULE_KEY];

  if (typeof current !== 'string') {
    return labels;
  }

  const healed = rewriteChronosRouterRuleValue(current);

  if (!healed) {
    return labels;
  }

  return { ...labels, [CHRONOS_ROUTER_RULE_KEY]: healed };
};

const rewriteLabelCollection = (
  labels: ReadonlyArray<string> | Record<string, any>,
): {
  labels: ReadonlyArray<string> | Record<string, any>;
  changed: boolean;
} => {
  if (Array.isArray(labels)) {
    let changed = false;

    const next = labels.map(label => {
      if (typeof label !== 'string') {
        return label;
      }

      const eq = label.indexOf('=');

      if (eq <= 0) {
        return label;
      }

      const key = label.slice(0, eq).trim();

      if (key !== CHRONOS_ROUTER_RULE_KEY) {
        return label;
      }

      const healed = rewriteChronosRouterRuleValue(label.slice(eq + 1));

      if (!healed) {
        return label;
      }

      changed = true;
      return `${key}=${healed}`;
    });

    return { labels: next, changed };
  }

  const current = labels[CHRONOS_ROUTER_RULE_KEY];

  if (typeof current !== 'string') {
    return { labels, changed: false };
  }

  const healed = rewriteChronosRouterRuleValue(current);

  if (!healed) {
    return { labels, changed: false };
  }

  return {
    labels: { ...labels, [CHRONOS_ROUTER_RULE_KEY]: healed },
    changed: true,
  };
};

/**
 * Rewrite a Chronos Traefik router that claims every `/api/` path.
 * Idempotent: a rule without a standalone PathPrefix(`/api/`) is left alone.
 * Image tags are never touched.
 */
export const rewriteChronosRouterLabels = (
  services: Readonly<Record<string, RawComposeService>> | undefined,
): {
  services: Record<string, RawComposeService>;
  updatedIds: readonly string[];
} => {
  const source = services ?? {};
  const chronosName = process.env.CHRONOS_NAME || 'gluesync-chronos';
  const updatedIds: string[] = [];

  const next = Object.entries(source).reduce<
    Record<string, RawComposeService>
  >((acc, [name, service]) => {
    const image = String(service?.image ?? '');
    const labelStrings = toLabelStrings(service?.labels);
    const isChronos =
      name === chronosName ||
      image.includes('gluesync-chronos') ||
      labelStrings.some(label =>
        label.startsWith(`${CHRONOS_ROUTER_RULE_KEY}=`),
      );

    if (!isChronos || !service?.labels) {
      return { ...acc, [name]: service };
    }

    const rewritten = rewriteLabelCollection(service.labels);

    if (!rewritten.changed) {
      return { ...acc, [name]: service };
    }

    updatedIds.push(name);

    return {
      ...acc,
      [name]: { ...service, labels: rewritten.labels },
    };
  }, {});

  return { services: next, updatedIds };
};
