import { isDeepStrictEqual } from 'node:util';
import { YAMLMap, YAMLSeq, isMap, isScalar, isSeq } from 'yaml';

import {
  ParsedYaml,
  parseYamlMapping,
} from '../healTraefikConf/yamlLikeSource';
import {
  Edit,
  JsPath,
  Spliced,
  applyVerified,
  assertNoCommentLines,
  attempt,
  climbBare,
  contentEndOf,
  createAt,
  deleteAt,
  deleteLines,
  endOf,
  insertLinesAfter,
  isBlockMap,
  keyColumn,
  lineStartOf,
  pad,
  pairAt,
  rangeOf,
  restIsBlankOrComment,
  unsafeLayout,
  updateAt,
  widenOverComment,
} from '../healTraefikConf/yamlSplice';

import {
  ERRORPAGES_ADDRESS,
  ERRORPAGES_COMMENT,
  ERRORPAGES_ENTRYPOINT,
  PAGES_MIDDLEWARE,
  PLUGIN_COMMENT,
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

const parsedOrThrow = (text: string): Parsed => {
  const doc = parse(text);

  if (typeof doc === 'string') {
    throw unsafeLayout(`traefik.yml is ${doc}`);
  }

  return doc;
};

// Each step below parses the text it is given, locates what it changes and
// splices only those bytes into the text (see yamlSplice): nothing of the
// customer's layout is rewritten. A layout it cannot splice safely makes the
// step throw an "unsafe layout" error.

const isOurs = (item: unknown): boolean =>
  isScalar(item) && item.value === PAGES_MIDDLEWARE;

// ------------------------------------------------------------------- add

const addToBlockList = (text: string, seq: Readonly<YAMLSeq>): Edit => {
  if (!seq.items.every(isScalar)) {
    throw unsafeLayout('the middlewares list has items that are not plain');
  }

  const first = lineStartOf(text, rangeOf(seq)[0]);
  const dash = /^( *- +)/.exec(text.slice(first, contentEndOf(text, first)));

  if (!dash) {
    throw unsafeLayout('the middlewares list does not start its line');
  }

  return insertLinesAfter(text, endOf(text, seq), [
    `${dash[1]}${PAGES_MIDDLEWARE}`,
  ]);
};

const addToFlowList = (text: string, seq: Readonly<YAMLSeq>): Edit => {
  const [open] = rangeOf(seq);
  const last = seq.items.at(-1);

  if (text[open] !== '[') {
    throw unsafeLayout('the middlewares list is not in brackets');
  }

  if (last === undefined) {
    return { start: open + 1, end: open + 1, insert: PAGES_MIDDLEWARE };
  }

  const at = rangeOf(last)[1];

  return { start: at, end: at, insert: `, ${PAGES_MIDDLEWARE}` };
};

const addPagesMiddleware = (text: string): string => {
  const doc = parsedOrThrow(text);
  const current = doc.getIn(MIDDLEWARES_PATH, true);

  if (isSeq(current) && current.items.some(isOurs)) {
    return text;
  }

  const edit = ((): Edit => {
    if (isSeq(current)) {
      return current.flow
        ? addToFlowList(text, current)
        : addToBlockList(text, current);
    }

    if (
      current !== undefined &&
      !(isScalar(current) && current.value === null)
    ) {
      throw unsafeLayout('the middlewares of websecure are not a list');
    }

    return createAt(doc, text, MIDDLEWARES_PATH, column => [
      `${pad(column)}- ${PAGES_MIDDLEWARE}`,
    ]);
  })();

  return applyVerified(text, [edit], js =>
    updateAt(js, MIDDLEWARES_PATH, list =>
      Array.isArray(list) ? [...list, PAGES_MIDDLEWARE] : [PAGES_MIDDLEWARE],
    ),
  );
};

const addPlugin = (text: string): string => {
  const doc = parsedOrThrow(text);

  if (doc.hasIn(PLUGIN_PATH)) {
    return text;
  }

  return applyVerified(
    text,
    [
      createAt(doc, text, PLUGIN_PATH, column => [
        `${pad(column)}moduleName: ${PLUGIN_MODULE}`,
      ]),
    ],
    js => updateAt(js, PLUGIN_PATH, () => ({ moduleName: PLUGIN_MODULE })),
  );
};

// ---------------------------------------------------------------- remove

const BARE_PRUNE: ReadonlyArray<JsPath> = [MIDDLEWARES_PATH, HTTP_PATH];
const PLUGIN_PRUNE: ReadonlyArray<JsPath> = [
  LOCAL_PLUGINS_PATH,
  EXPERIMENTAL_PATH,
];

const mapAt = (doc: Parsed, path: JsPath): YAMLMap => {
  const node = doc.getIn(path, true);

  if (!isBlockMap(node)) {
    throw unsafeLayout(`${path.join('.')} is not a block mapping`);
  }

  return node;
};

/** Our entry is on lines of its own, so those lines can go. */
const assertOwnLines = (text: string, start: number, end: number): void => {
  if (!restIsBlankOrComment(text, end)) {
    throw unsafeLayout('our entry shares its line with something else');
  }

  assertNoCommentLines(text, start, end);
};

const removeFromBlockList = (
  text: string,
  doc: Parsed,
  seq: Readonly<YAMLSeq>,
  index: number,
): Edit => {
  const item = seq.items[index];
  const [start] = rangeOf(item);
  const end = endOf(text, item);
  const dash = text.slice(lineStartOf(text, start), start);

  if (!/^ *- +$/.test(dash)) {
    throw unsafeLayout('our middleware is not alone after its dash');
  }

  assertOwnLines(text, start, end);

  const middlewares = pairAt(doc, MIDDLEWARES_PATH);
  const http = pairAt(doc, HTTP_PATH);
  const httpMap = mapAt(doc, HTTP_PATH);

  if (!middlewares || !http) {
    throw unsafeLayout('the middlewares of websecure moved');
  }

  const top = climbBare(text, start, [
    { pair: middlewares, count: seq.items.length },
    { pair: http, count: httpMap.items.length },
  ]);

  return deleteLines(text, top.start, end);
};

const removeFromFlowList = (
  text: string,
  seq: Readonly<YAMLSeq>,
  index: number,
): Edit => {
  const { items } = seq;
  const [start, end] = rangeOf(items[index]);

  if (items.length === 1) {
    return { start, end, insert: '' };
  }

  if (index > 0) {
    const previousEnd = rangeOf(items[index - 1])[1];

    if (!/^\s*,\s*$/.test(text.slice(previousEnd, start))) {
      throw unsafeLayout('our middleware has a comment next to it');
    }

    return { start: previousEnd, end, insert: '' };
  }

  const nextStart = rangeOf(items[1])[0];

  if (!/^\s*,\s*$/.test(text.slice(end, nextStart))) {
    throw unsafeLayout('our middleware has a comment next to it');
  }

  return { start, end: nextStart, insert: '' };
};

// One occurrence per round; a list that has ours twice is looked at again
const removePagesMiddleware = (text: string): string => {
  const doc = parsedOrThrow(text);
  const current = doc.getIn(MIDDLEWARES_PATH, true);
  const index = isSeq(current) ? current.items.findIndex(isOurs) : -1;

  if (!isSeq(current) || index < 0) {
    return text;
  }

  const edit = current.flow
    ? removeFromFlowList(text, current, index)
    : removeFromBlockList(text, doc, current, index);

  const next = applyVerified(
    text,
    [edit],
    js =>
      updateAt(js, MIDDLEWARES_PATH, list =>
        Array.isArray(list) ? list.filter((_, at) => at !== index) : list,
      ),
    BARE_PRUNE,
  );

  return next === text ? text : removePagesMiddleware(next);
};

const removePlugin = (text: string): string => {
  const doc = parsedOrThrow(text);

  if (pluginState(doc) !== 'ours') {
    return text;
  }

  const experimental = pairAt(doc, EXPERIMENTAL_PATH);
  const localPlugins = pairAt(doc, LOCAL_PLUGINS_PATH);
  const plugin = pairAt(doc, PLUGIN_PATH);
  const experimentalMap = mapAt(doc, EXPERIMENTAL_PATH);
  const localPluginsMap = mapAt(doc, LOCAL_PLUGINS_PATH);

  if (!experimental || !localPlugins || !plugin) {
    throw unsafeLayout('our plugin moved');
  }

  keyColumn(text, plugin);

  const start = rangeOf(plugin.key)[0];
  const end = endOf(text, plugin);

  assertOwnLines(text, start, end);

  const top = climbBare(text, start, [
    { pair: localPlugins, count: localPluginsMap.items.length },
    { pair: experimental, count: experimentalMap.items.length },
  ]);
  const span =
    top.levels === 2
      ? widenOverComment(text, top.start, end, PLUGIN_COMMENT)
      : { start: top.start, end };

  return applyVerified(
    text,
    [deleteLines(text, span.start, span.end)],
    js => deleteAt(js, PLUGIN_PATH),
    PLUGIN_PRUNE,
  );
};

const removeLegacyEntry = (text: string): string => {
  const doc = parsedOrThrow(text);

  if (!factsOf(doc).errorpagesIsOurs) {
    return text;
  }

  const entry = pairAt(doc, ERRORPAGES_PATH);

  mapAt(doc, ['entryPoints']);

  if (!entry) {
    throw unsafeLayout('the errorpages entry point moved');
  }

  keyColumn(text, entry);

  const start = rangeOf(entry.key)[0];
  const end = endOf(text, entry);

  assertOwnLines(text, start, end);

  const span = widenOverComment(text, start, end, ERRORPAGES_COMMENT);

  return applyVerified(text, [deleteLines(text, span.start, span.end)], js =>
    deleteAt(js, ERRORPAGES_PATH),
  );
};

// ---------------------------------------------------------------- public

export type StaticEdit = Spliced;

/**
 * `addStatic` that says why instead of throwing when the layout of the file
 * cannot be spliced safely (the text is then left as it is).
 */
export const tryAddStatic = (text: string): StaticEdit =>
  attempt(() => {
    const facts = factsOf(parsedOrThrow(text));

    // A file with nothing to add is not touched
    if (facts.hasPagesMiddleware && facts.plugin !== 'absent') {
      return text;
    }

    return addPlugin(addPagesMiddleware(text));
  });

/** `removeStatic` that says why instead of throwing, as `tryAddStatic`. */
export const tryRemoveStatic = (text: string): StaticEdit =>
  attempt(() => {
    const facts = factsOf(parsedOrThrow(text));

    if (
      !facts.hasPagesMiddleware &&
      facts.plugin !== 'ours' &&
      !facts.errorpagesIsOurs
    ) {
      return text;
    }

    return removeLegacyEntry(removePlugin(removePagesMiddleware(text)));
  });

const textOrThrow = (edit: StaticEdit): string => {
  if (!edit.ok) {
    throw new Error(edit.reason);
  }

  return edit.text;
};

/**
 * Adds `gluesync-pages@docker` to the websecure entry point's middlewares
 * (after the ones already there) and the plugin to `experimental.localPlugins`,
 * creating only the levels that are missing. Only the bytes added or removed change; a layout that cannot be spliced
 * safely throws (the heal then stops before it writes anything).
 */
export const addStatic = (text: string): string =>
  textOrThrow(tryAddStatic(text));

/**
 * Removes exactly what `addStatic` (and v0.0.286) added: our list item, our
 * plugin entry and the `errorpages` entry when it is exactly ours, then the
 * containers that are empty because of it and hold nothing else. Throws like
 * `addStatic`.
 */
export const removeStatic = (text: string): string =>
  textOrThrow(tryRemoveStatic(text));
