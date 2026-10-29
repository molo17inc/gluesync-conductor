/**
 * What "ours" means for the MOLO17 error pages (see the shared contract):
 * the exact keys, labels and values below, nothing else. Everything the
 * Conductor adds or removes is listed here.
 */

export const OPT_OUT_LABEL = 'com.molo17.conductor.error-pages';

export const PAGES_MIDDLEWARE = 'gluesync-pages@docker';
export const PLUGIN_KEY = 'gluesyncerrorpages';
export const PLUGIN_MODULE = 'github.com/molo17/gluesyncerrorpages';

export const ERRORPAGES_ENTRYPOINT = 'errorpages';
export const ERRORPAGES_ADDRESS = ':8099';

/** The comment lines v0.0.286 wrote above its entries of traefik.yml. */
export const ERRORPAGES_COMMENT =
  '# Internal only (not published in compose): serves the MOLO17 error pages to the errors middleware.';
export const PLUGIN_COMMENT =
  '# Error pages: Traefik local plugin, baked into the molo17/traefik image (/plugins-local).';

/** First molo17/traefik tag that has the wrapper mode (`mode: wrap`). */
export const CAPABLE_FROM = [3, 7, 16, 3] as const;
/** First tag that has the plugin at all (legacy mode, what v0.0.286 kits use). */
export const LEGACY_PLUGIN_FROM = [3, 7, 16, 1] as const;

export const TRAEFIK_ENABLE = 'traefik.enable';

export type LabelSet = Readonly<Record<string, string>>;

const PAGES_ROOT_KEY = `traefik.http.middlewares.gluesync-pages.plugin.${PLUGIN_KEY}.root`;
const UNAVAILABLE = 'traefik.http.routers.gluesync-unavailable';

export const pagesRoot = (isWindows: boolean): string =>
  isWindows ? String.raw`C:\gluesync\error-pages` : '/gluesync/error-pages';

/** Labels of the target wiring, on the reverse-proxy service only. */
export const targetLabels = (isWindows: boolean): LabelSet => ({
  [TRAEFIK_ENABLE]: 'true',
  [PAGES_ROOT_KEY]: pagesRoot(isWindows),
  [`traefik.http.middlewares.gluesync-pages.plugin.${PLUGIN_KEY}.mode`]: 'wrap',
  [`traefik.http.middlewares.gluesync-unavailable.plugin.${PLUGIN_KEY}.root`]:
    pagesRoot(isWindows),
  [`traefik.http.middlewares.gluesync-unavailable.plugin.${PLUGIN_KEY}.mode`]:
    'unavailable',
  [`${UNAVAILABLE}.rule`]: 'PathPrefix(`/`)',
  [`${UNAVAILABLE}.priority`]: '1',
  [`${UNAVAILABLE}.entrypoints`]: 'websecure',
  [`${UNAVAILABLE}.tls`]: 'true',
  [`${UNAVAILABLE}.service`]: 'noop@internal',
  [`${UNAVAILABLE}.middlewares`]: 'gluesync-unavailable@docker',
});

/** Labels trial-assembler v0.0.286 put on the reverse-proxy service. */
export const legacyProxyLabels = (isWindows: boolean): LabelSet => ({
  [TRAEFIK_ENABLE]: 'true',
  [PAGES_ROOT_KEY]: pagesRoot(isWindows),
  'traefik.http.routers.error-pages.entrypoints': ERRORPAGES_ENTRYPOINT,
  'traefik.http.routers.error-pages.rule': 'PathPrefix(`/`)',
  'traefik.http.routers.error-pages.service': 'noop@internal',
  'traefik.http.routers.error-pages.middlewares': PAGES_MIDDLEWARE,
  'traefik.http.services.error-pages.loadbalancer.server.port': '8099',
  'traefik.http.middlewares.gluesync-errors.errors.status': '404,500-503',
  'traefik.http.middlewares.gluesync-errors.errors.service': 'error-pages',
  'traefik.http.middlewares.gluesync-errors.errors.query': '/{status}.html',
  [`${UNAVAILABLE}.rule`]: 'PathPrefix(`/`)',
  [`${UNAVAILABLE}.priority`]: '1',
  [`${UNAVAILABLE}.entrypoints`]: 'websecure',
  [`${UNAVAILABLE}.tls`]: 'true',
  [`${UNAVAILABLE}.service`]: 'noop@internal',
  [`${UNAVAILABLE}.middlewares`]: PAGES_MIDDLEWARE,
});

/** Routers v0.0.286 added next to the services' own (`<name>-html`). */
export const LEGACY_HTML_ROUTERS: ReadonlyArray<string> = [
  'corehub',
  'chronos',
  'conductor',
  'prometheus',
  'grafana',
];

const HTML_RULE = /^\(.*\) && HeaderRegexp\(`Accept`, `text\/html`\)$/;
const HTML_MIDDLEWARES = /^(.+,)?gluesync-errors@docker$/;

const htmlRouterValue = (router: string, field: string): RegExp | string => {
  switch (field) {
    case 'rule':
      return HTML_RULE;
    case 'entrypoints':
      return 'websecure';
    case 'tls':
      return 'true';
    case 'service':
      return router;
    case 'middlewares':
      return HTML_MIDDLEWARES;
    case 'priority':
      return router === 'corehub' ? '3' : '';
    default:
      return '';
  }
};

const matches = (
  expected: Readonly<RegExp> | string,
  value: string,
): boolean =>
  typeof expected === 'string' ? expected === value : expected.test(value);

/**
 * `legacy`: label of the other services v0.0.286 added (an `-html` router of
 * the services' own, or Core Hub's priority). `exact`: it has the value v0.0.286
 * wrote. A `legacy` label that is not `exact` was changed by the customer.
 */
export type LegacyServiceLabel = Readonly<{ legacy: boolean; exact: boolean }>;

const HTML_KEY = new RegExp(
  `^traefik\\.http\\.routers\\.(${LEGACY_HTML_ROUTERS.join('|')})-html\\.([a-z]+)$`,
);

export const classifyLegacyServiceLabel = (
  key: string,
  value: string,
): LegacyServiceLabel => {
  if (key === 'traefik.http.routers.corehub.priority') {
    return { legacy: true, exact: value === '2' };
  }

  const match = HTML_KEY.exec(key);

  if (!match) {
    return { legacy: false, exact: false };
  }

  const [, router, field] = match;

  return {
    legacy: true,
    exact: matches(htmlRouterValue(router, field), value),
  };
};

export type LabelClass = 'target' | 'legacy' | 'both' | 'other' | 'custom';

/** Where a label of the reverse-proxy stands against both wirings. */
export const classifyProxyLabel = (
  key: string,
  value: string,
  target: LabelSet,
  legacy: LabelSet,
): LabelClass => {
  const inTarget = key in target;
  const inLegacy = key in legacy;

  if (!inTarget && !inLegacy) {
    return 'other';
  }

  const isTarget = inTarget && target[key] === value;
  const isLegacy = inLegacy && legacy[key] === value;

  if (isTarget && isLegacy) {
    return 'both';
  }

  if (isTarget) {
    return 'target';
  }

  return isLegacy ? 'legacy' : 'custom';
};

// ------------------------------------------------------------------ tags

export type TagVersion = ReadonlyArray<number>;

/** Tag of an image reference; undefined without a tag. A digest is ignored. */
export const imageTag = (image: string): string | undefined => {
  const reference = image.split('@')[0];
  const afterSlash = reference.slice(reference.lastIndexOf('/') + 1);
  const colon = afterSlash.indexOf(':');

  return colon < 0 ? undefined : afterSlash.slice(colon + 1);
};

/**
 * Leading numeric dotted part of the tag: `3.7.16.3-win-nanoserver-ltsc2022`
 * and `3.7.16.3.develop` are both 3.7.16.3. A tag that does not start with a
 * number (`latest`, `v3.1`) has no version.
 */
export const parseTagVersion = (
  tag: string | undefined,
): TagVersion | undefined => {
  const match = /^\d+(?:\.\d+)*/.exec(tag ?? '');

  return match ? match[0].split('.').map(Number) : undefined;
};

/** Numeric comparison, a missing part counts as 0. */
export const compareVersions = (a: TagVersion, b: TagVersion): number => {
  const length = Math.max(a.length, b.length);
  const diff = Array.from({ length }, (_, i) => (a[i] ?? 0) - (b[i] ?? 0));

  return diff.find(d => d !== 0) ?? 0;
};

const isMolo17Traefik = (image: string): boolean =>
  /(^|\/)molo17\/traefik$/.test(image.split('@')[0].replace(/:[^/:]*$/, ''));

export const atLeast = (image: string, minimum: TagVersion): boolean => {
  const version = parseTagVersion(imageTag(image));

  return (
    isMolo17Traefik(image) &&
    version !== undefined &&
    compareVersions(version, minimum) >= 0
  );
};

/** molo17/traefik 3.7.16.3 or later: has the wrapper mode. */
export const isCapableImage = (image: string): boolean =>
  atLeast(image, CAPABLE_FROM);

/** molo17/traefik 3.7.16.1 or later: has the plugin (legacy mode at least). */
export const hasLegacyPlugin = (image: string): boolean =>
  atLeast(image, LEGACY_PLUGIN_FROM);

export const isInterpolated = (image: string): boolean => image.includes('$');
