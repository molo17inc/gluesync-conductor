import { isDeepStrictEqual } from 'node:util';
import { isMap, isScalar, isSeq } from 'yaml';

import {
  ParsedYaml,
  parseYamlMapping,
  renderLikeSource,
} from '../healTraefikConf/yamlLikeSource';

import {
  ERRORPAGES_ADDRESS,
  ERRORPAGES_ENTRYPOINT,
  PAGES_MIDDLEWARE,
  PLUGIN_KEY,
  PLUGIN_MODULE,
} from './errorPagesWiring';

const WEBSECURE_PATH = ['entryPoints', 'websecure'] as const;
const HTTP_PATH = [...WEBSECURE_PATH, 'http'] as const;
const MIDDLEWARES_PATH = [...HTTP_PATH, 'middlewares'] as const;
const ERRORPAGES_PATH = ['entryPoints', ERRORPAGES_ENTRYPOINT] as const;
const EXPERIMENTAL_PATH = ['experimental'] as const;
const LOCAL_PLUGINS_PATH = [...EXPERIMENTAL_PATH, 'localPlugins'] as const;
const PLUGIN_PATH = [...LOCAL_PLUGINS_PATH, PLUGIN_KEY] as const;

type Parsed = Readonly<ParsedYaml>;

export type TraefikStaticFacts = Readonly<{
  hasWebsecure: boolean;
  /** `entryPoints.websecure.http.middlewares`: absent (or empty), a list, or something else. */
  middlewares: 'absent' | 'list' | 'other';
  hasPagesMiddleware: boolean;
  plugin: 'absent' | 'ours' | 'different';
  /** `entryPoints.errorpages` exists / is exactly the v0.0.286 definition. */
  hasErrorpagesEntry: boolean;
  errorpagesIsOurs: boolean;
}>;

export type InspectedTraefikStatic =
  | Readonly<{ ok: false; problem: string }>
  | Readonly<{ ok: true; facts: TraefikStaticFacts }>;

const parse = parseYamlMapping;

const jsonAt = (doc: Parsed, path: ReadonlyArray<string>): unknown => {
  const node = doc.getIn(path, true);

  return isScalar(node) || isMap(node) || isSeq(node) ? node.toJSON() : node;
};

const middlewaresShape = (doc: Parsed): TraefikStaticFacts['middlewares'] => {
  const node = doc.getIn(MIDDLEWARES_PATH, true);

  if (node === undefined || (isScalar(node) && node.value === null)) {
    return 'absent';
  }

  return isSeq(node) ? 'list' : 'other';
};

const pluginState = (doc: Parsed): TraefikStaticFacts['plugin'] => {
  const plugin = jsonAt(doc, PLUGIN_PATH);

  if (plugin === undefined) {
    return 'absent';
  }

  return isDeepStrictEqual(plugin, { moduleName: PLUGIN_MODULE })
    ? 'ours'
    : 'different';
};

const factsOf = (doc: Parsed): TraefikStaticFacts => {
  const middlewares = jsonAt(doc, MIDDLEWARES_PATH);

  return {
    hasWebsecure: isMap(doc.getIn(WEBSECURE_PATH, true)),
    middlewares: middlewaresShape(doc),
    hasPagesMiddleware:
      Array.isArray(middlewares) && middlewares.includes(PAGES_MIDDLEWARE),
    plugin: pluginState(doc),
    hasErrorpagesEntry: doc.hasIn(ERRORPAGES_PATH),
    errorpagesIsOurs: isDeepStrictEqual(jsonAt(doc, ERRORPAGES_PATH), {
      address: ERRORPAGES_ADDRESS,
    }),
  };
};

/** Read-only look at the static file: the facts the planner decides on. */
export const inspectTraefikStatic = (text: string): InspectedTraefikStatic => {
  const doc = parse(text);

  return typeof doc === 'string'
    ? { ok: false, problem: doc }
    : { ok: true, facts: factsOf(doc) };
};

const render = renderLikeSource;

const parsedOrThrow = (text: string): Parsed => {
  const doc = parse(text);

  if (typeof doc === 'string') {
    throw new Error(`traefik.yml is ${doc}`);
  }

  return doc;
};

// ------------------------------------------------------------------- add

const addPagesMiddleware = (doc: Parsed): void => {
  const current = doc.getIn(MIDDLEWARES_PATH, true);

  if (isSeq(current)) {
    if (
      !current.items.some(
        item => isScalar(item) && item.value === PAGES_MIDDLEWARE,
      )
    ) {
      current.add(doc.createNode(PAGES_MIDDLEWARE));
    }
    return;
  }

  doc.setIn(MIDDLEWARES_PATH, doc.createNode([PAGES_MIDDLEWARE]));
};

const addPlugin = (doc: Parsed): void => {
  if (!doc.hasIn(PLUGIN_PATH)) {
    doc.setIn(PLUGIN_PATH, doc.createNode({ moduleName: PLUGIN_MODULE }));
  }
};

const removeLegacyEntry = (doc: Parsed): void => {
  if (
    isDeepStrictEqual(jsonAt(doc, ERRORPAGES_PATH), {
      address: ERRORPAGES_ADDRESS,
    })
  ) {
    doc.deleteIn(ERRORPAGES_PATH);
  }
};

/**
 * Adds `gluesync-pages@docker` to the websecure entry point's middlewares
 * (after the ones already there) and the plugin to `experimental.localPlugins`,
 * creating only the levels that are missing. With `dropLegacyEntry` the
 * `entryPoints.errorpages` that v0.0.286 added goes, when it is exactly ours.
 */
export const addStatic = (
  text: string,
  { dropLegacyEntry = false }: Readonly<{ dropLegacyEntry?: boolean }> = {},
): string => {
  const doc = parsedOrThrow(text);
  const facts = factsOf(doc);

  // A file with nothing to add is not written again in the library's layout
  if (
    facts.hasPagesMiddleware &&
    facts.plugin !== 'absent' &&
    !(dropLegacyEntry && facts.errorpagesIsOurs)
  ) {
    return text;
  }

  addPagesMiddleware(doc);
  addPlugin(doc);

  if (dropLegacyEntry) {
    removeLegacyEntry(doc);
  }

  return render(doc, text);
};

// ---------------------------------------------------------------- remove

const isEmptyContainer = (
  doc: Parsed,
  path: ReadonlyArray<string>,
): boolean => {
  const node = doc.getIn(path, true);

  return (isMap(node) || isSeq(node)) && node.items.length === 0;
};

// A container that was created for us and is empty now goes too, outermost last
const pruneIfEmpty = (doc: Parsed, path: ReadonlyArray<string>): void => {
  if (isEmptyContainer(doc, path)) {
    doc.deleteIn(path);
  }
};

const removePagesMiddleware = (doc: Parsed): void => {
  const current = doc.getIn(MIDDLEWARES_PATH, true);

  if (!isSeq(current)) {
    return;
  }

  current.items
    .map((item, index) =>
      isScalar(item) && item.value === PAGES_MIDDLEWARE ? index : -1,
    )
    .filter(index => index >= 0)
    .reverse()
    .forEach(index => current.delete(index));

  pruneIfEmpty(doc, MIDDLEWARES_PATH);
  pruneIfEmpty(doc, HTTP_PATH);
};

const removePlugin = (doc: Parsed): void => {
  if (pluginState(doc) === 'ours') {
    doc.deleteIn(PLUGIN_PATH);
    pruneIfEmpty(doc, LOCAL_PLUGINS_PATH);
    pruneIfEmpty(doc, EXPERIMENTAL_PATH);
  }
};

/**
 * Removes exactly what `addStatic` (and v0.0.286) added: our list item, our
 * plugin entry and the `errorpages` entry when it is exactly ours, then the
 * containers that are empty because of it.
 */
export const removeStatic = (text: string): string => {
  const doc = parsedOrThrow(text);
  const facts = factsOf(doc);

  if (
    !facts.hasPagesMiddleware &&
    facts.plugin !== 'ours' &&
    !facts.errorpagesIsOurs
  ) {
    return text;
  }

  removePagesMiddleware(doc);
  removePlugin(doc);
  removeLegacyEntry(doc);

  return render(doc, text);
};
