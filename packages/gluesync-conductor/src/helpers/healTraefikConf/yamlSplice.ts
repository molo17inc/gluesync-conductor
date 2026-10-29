/**
 * Edits a YAML file by splicing text into the original string. The `yaml`
 * library only PARSES and LOCATES (node ranges); it never writes, so every
 * byte we do not add or remove (comments, spacing, quoting, key order, blank
 * lines, line ends, final newline, indentation) stays as the customer had it.
 * A layout that cannot be spliced safely throws an "unsafe layout" error and
 * the caller leaves the file alone.
 */
import { isDeepStrictEqual } from 'node:util';
import { Pair, YAMLMap, isMap, isPair, isScalar, isSeq } from 'yaml';

import { ParsedYaml, parseYamlMapping } from './yamlLikeSource';

export type Edit = Readonly<{ start: number; end: number; insert: string }>;
export type JsPath = ReadonlyArray<string>;
export type Spliced =
  | Readonly<{ ok: true; text: string }>
  | Readonly<{ ok: false; reason: string }>;

// ---------------------------------------------------------------- errors

export const unsafeLayout = (reason: string): Error =>
  Object.assign(new Error(reason), { unsafeLayout: true as const });

export const isUnsafeLayout = (error: unknown): error is Error =>
  error instanceof Error && 'unsafeLayout' in error;

/** Runs a splice: its text, or why the layout was left alone. */
export const attempt = (splice: () => string): Spliced => {
  try {
    return { ok: true, text: splice() };
  } catch (error) {
    if (isUnsafeLayout(error)) {
      return { ok: false, reason: error.message };
    }

    throw error;
  }
};

// ----------------------------------------------------------------- lines

export const lineStartOf = (text: string, offset: number): number =>
  offset <= 0 ? 0 : text.lastIndexOf('\n', offset - 1) + 1;

/** End of the line's text: before its CR LF / LF, or the end of the file. */
export const contentEndOf = (text: string, offset: number): number => {
  const newline = text.indexOf('\n', offset);
  const end = newline === -1 ? text.length : newline;

  return end > 0 && newline !== -1 && text[end - 1] === '\r' ? end - 1 : end;
};

export const nextLineStart = (text: string, offset: number): number => {
  const newline = text.indexOf('\n', offset);

  return newline === -1 ? text.length : newline + 1;
};

const dominantEol = (text: string): string =>
  text.includes('\r\n') ? '\r\n' : '\n';

const eolLengthAt = (text: string, contentEnd: number): number => {
  if (contentEnd >= text.length) {
    return 0;
  }

  return text[contentEnd] === '\r' ? 2 : 1;
};

type TextLine = Readonly<{ start: number; end: number; text: string }>;

export const lineBefore = (
  text: string,
  offset: number,
): TextLine | undefined => {
  const here = lineStartOf(text, offset);

  if (here === 0) {
    return undefined;
  }

  const start = lineStartOf(text, here - 1);
  const end = contentEndOf(text, start);

  return { start, end, text: text.slice(start, end) };
};

export const lineAfter = (
  text: string,
  offset: number,
): TextLine | undefined => {
  const start = nextLineStart(text, offset);

  if (start >= text.length) {
    return undefined;
  }

  const end = contentEndOf(text, start);

  return { start, end, text: text.slice(start, end) };
};

export const restIsBlankOrComment = (text: string, offset: number): boolean =>
  /^\s*(#.*)?$/.test(text.slice(offset, contentEndOf(text, offset)));

export const pad = (width: number): string => ' '.repeat(width);

// ----------------------------------------------------------------- edits

export const applyEdits = (text: string, edits: ReadonlyArray<Edit>): string =>
  [...edits]
    .sort((a, b) => b.start - a.start)
    .reduce(
      (acc, edit) =>
        acc.slice(0, edit.start) + edit.insert + acc.slice(edit.end),
      text,
    );

/**
 * New lines right after the line that holds `offset`, in that line's line
 * ending. A last line without a line end gets one before the new text, so the
 * file still has no final newline.
 */
export const insertLinesAfter = (
  text: string,
  offset: number,
  lines: ReadonlyArray<string>,
): Edit => {
  const end = contentEndOf(text, offset);
  const eolLength = eolLengthAt(text, end);

  if (eolLength === 0) {
    const eol = dominantEol(text);

    return {
      start: end,
      end,
      insert: lines.map(line => `${eol}${line}`).join(''),
    };
  }

  const eol = text.slice(end, end + eolLength);
  const next = end + eolLength;

  return {
    start: next,
    end: next,
    insert: lines.map(line => `${line}${eol}`).join(''),
  };
};

/** Removes whole lines, from the one holding `from` to the one holding `to`. */
export const deleteLines = (text: string, from: number, to: number): Edit => {
  const start = lineStartOf(text, from);
  const end = contentEndOf(text, to);
  const eolLength = eolLengthAt(text, end);

  if (eolLength > 0) {
    return { start, end: end + eolLength, insert: '' };
  }

  if (start === 0) {
    return { start, end, insert: '' };
  }

  // Last line without a line end: the one before it goes with it
  const before = text[start - 2] === '\r' ? 2 : 1;

  return { start: start - before, end, insert: '' };
};

// ---------------------------------------------------------------- nodes

type Range3 = readonly [number, number, number];

export const rangeOf = (node: unknown): Range3 => {
  const range = (node as { range?: Range3 | null } | null | undefined)?.range;

  if (!range) {
    throw unsafeLayout('a node has no position in the text');
  }

  return range;
};

export const isNullValue = (node: unknown): boolean =>
  node === null ||
  node === undefined ||
  (isScalar(node) &&
    node.value === null &&
    rangeOf(node)[0] === rangeOf(node)[1]);

export const isBlockMap = (node: unknown): node is YAMLMap =>
  isMap(node) && !node.flow && node.items.length > 0;

/** Offset right after the last character of the node's own text. */
export const endOf = (text: string, node: unknown): number => {
  if (isPair(node)) {
    const keyEnd = rangeOf(node.key)[1];

    return isNullValue(node.value)
      ? keyEnd
      : Math.max(keyEnd, endOf(text, node.value));
  }

  if ((isMap(node) || isSeq(node)) && !node.flow && node.items.length > 0) {
    return endOf(text, node.items[node.items.length - 1]);
  }

  const [start, end] = rangeOf(node);

  return start + text.slice(start, end).trimEnd().length;
};

const columnOf = (text: string, offset: number): number | undefined => {
  const start = lineStartOf(text, offset);

  return /^ *$/.test(text.slice(start, offset)) ? offset - start : undefined;
};

/** Column of a key that starts its line. */
export const keyColumn = (text: string, pair: Readonly<Pair>): number => {
  const column = columnOf(text, rangeOf(pair.key)[0]);

  if (column === undefined) {
    throw unsafeLayout('a key does not start its line');
  }

  return column;
};

export const findPair = (
  map: Readonly<YAMLMap>,
  key: string,
): Pair | undefined =>
  map.items.find(pair => isScalar(pair.key) && pair.key.value === key);

export const pairAt = (
  doc: Readonly<ParsedYaml>,
  path: JsPath,
): Pair | undefined =>
  path.reduce<Pair | undefined | 'root'>((found, key) => {
    const map = found === 'root' ? doc.contents : found?.value;

    return isMap(map) ? findPair(map, key) : undefined;
  }, 'root') as Pair | undefined;

const stepIn = (text: string, map: Readonly<YAMLMap>): number | undefined =>
  map.items
    .map(pair => {
      const { value } = pair;

      if (!isBlockMap(value)) {
        return undefined;
      }

      const outer = columnOf(text, rangeOf(pair.key)[0]);
      const inner = columnOf(text, rangeOf(value.items[0].key)[0]);

      return outer !== undefined && inner !== undefined && inner > outer
        ? inner - outer
        : stepIn(text, value);
    })
    .find(step => step !== undefined);

/** Width of one indentation level, read from the first nested mapping. */
export const fileStep = (doc: Readonly<ParsedYaml>, text: string): number =>
  (isMap(doc.contents) ? stepIn(text, doc.contents) : undefined) ?? 2;

// ------------------------------------------------------------- locating

export type Located = Readonly<{
  /** How many keys of the path exist (a key with no value counts). */
  depth: number;
  /** Lines of anything new go after the line that holds this offset. */
  anchor: number;
  /** Column of a new child of the deepest container that exists. */
  childCol: number;
  /** The pair at the path, when all of it exists. */
  pair?: Pair;
}>;

/**
 * Where something at `path` goes: the deepest block mapping that exists, and
 * the column and line a new child of it takes. A key with no value
 * (`http:`) is a container too, its children go right below it.
 */
export const locate = (
  doc: Readonly<ParsedYaml>,
  text: string,
  path: JsPath,
): Located => {
  const step = fileStep(doc, text);

  const walk = (map: Readonly<YAMLMap>, depth: number): Located => {
    const pair = findPair(map, path[depth]);

    if (!pair) {
      return {
        depth,
        anchor: endOf(text, map),
        childCol: keyColumn(text, map.items[0]),
      };
    }

    const column = keyColumn(text, pair);

    if (isNullValue(pair.value)) {
      return {
        depth: depth + 1,
        anchor: rangeOf(pair.key)[1],
        childCol: column + step,
        pair,
      };
    }

    if (depth === path.length - 1) {
      return {
        depth: depth + 1,
        anchor: endOf(text, pair),
        childCol: column + step,
        pair,
      };
    }

    if (isBlockMap(pair.value)) {
      return walk(pair.value, depth + 1);
    }

    throw unsafeLayout(
      `${path.slice(0, depth + 1).join('.')} is not a block mapping`,
    );
  };

  if (!isBlockMap(doc.contents)) {
    throw unsafeLayout('the document is not a block mapping');
  }

  return walk(doc.contents, 0);
};

/**
 * The edit that creates the part of `path` that is missing, nested one
 * indentation step per level, with `leaf` lines (given their column) at the
 * bottom.
 */
export const createAt = (
  doc: Readonly<ParsedYaml>,
  text: string,
  path: JsPath,
  leaf: (column: number) => ReadonlyArray<string>,
): Edit => {
  const located = locate(doc, text, path);

  if (located.pair && !isNullValue(located.pair.value)) {
    throw unsafeLayout(`${path.join('.')} is already there`);
  }

  const step = fileStep(doc, text);
  const missing = path.slice(located.depth);

  return insertLinesAfter(text, located.anchor, [
    ...missing.map((key, i) => `${pad(located.childCol + i * step)}${key}:`),
    ...leaf(located.childCol + missing.length * step),
  ]);
};

// ------------------------------------------------------------- pruning

export type Parent = Readonly<{ pair: Pair; count: number }>;

/**
 * The container `parent` is empty once its only child at `childStart` goes,
 * and holds nothing else: no value, no comment on its key line, no line
 * between its key and the child.
 */
const holdsOnly = (
  text: string,
  parent: Parent,
  childStart: number,
): boolean => {
  const keyEnd = rangeOf(parent.pair.key)[1];

  keyColumn(text, parent.pair);

  return (
    parent.count === 1 &&
    /^\s*:\s*$/.test(text.slice(keyEnd, contentEndOf(text, keyEnd))) &&
    nextLineStart(text, keyEnd) === lineStartOf(text, childStart)
  );
};

/**
 * Climbs from a child about to be removed through the containers (inner to
 * outer) that its removal leaves empty and bare. `start` is where the lines
 * to delete begin, `levels` how many containers go with the child.
 */
export const climbBare = (
  text: string,
  childStart: number,
  parents: ReadonlyArray<Parent>,
): Readonly<{ start: number; levels: number }> =>
  parents.reduce(
    (top, parent, index) =>
      top.levels === index && holdsOnly(text, parent, top.start)
        ? { start: rangeOf(parent.pair.key)[0], levels: index + 1 }
        : top,
    { start: childStart, levels: 0 },
  );

/**
 * The lines to delete, widened over the comment line the MOLO17 kit put right
 * above them when it is exactly `comment`, and over one blank line when that
 * would leave two in a row.
 */
export const widenOverComment = (
  text: string,
  start: number,
  end: number,
  comment: string,
): Readonly<{ start: number; end: number }> => {
  const above = lineBefore(text, start);

  if (!above || above.text.trim() !== comment) {
    return { start, end };
  }

  const beforeComment = lineBefore(text, above.start);
  const below = lineAfter(text, end);
  const doubleBlank =
    beforeComment?.text.trim() === '' && below?.text.trim() === '';

  return { start: above.start, end: doubleBlank && below ? below.end : end };
};

/** The lines of a node we remove hold no comment line of the customer's. */
export const assertNoCommentLines = (
  text: string,
  start: number,
  end: number,
): void => {
  const [, ...inner] = text.slice(lineStartOf(text, start), end).split(/\r?\n/);

  if (inner.some(line => line.trim().startsWith('#'))) {
    throw unsafeLayout('the entry to remove has a comment of its own');
  }
};

// --------------------------------------------------------- verification

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const getAt = (value: unknown, path: JsPath): unknown =>
  path.reduce<unknown>(
    (current, key) => (isRecord(current) ? current[key] : undefined),
    value,
  );

export const updateAt = (
  value: unknown,
  path: JsPath,
  change: (current: unknown) => unknown,
): unknown => {
  if (path.length === 0) {
    return change(value);
  }

  const [head, ...rest] = path;
  const base = isRecord(value) ? value : {};

  return { ...base, [head]: updateAt(base[head], rest, change) };
};

export const deleteAt = (value: unknown, path: JsPath): unknown => {
  if (!isRecord(value) || path.length === 0) {
    return value;
  }

  const [head, ...rest] = path;

  if (rest.length === 0) {
    return Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== head),
    );
  }

  return head in value
    ? { ...value, [head]: deleteAt(value[head], rest) }
    : value;
};

const isEmptyValue = (value: unknown): boolean =>
  value === null ||
  value === undefined ||
  (Array.isArray(value) && value.length === 0) ||
  (isRecord(value) && Object.keys(value).length === 0);

const dropIfEmpty = (value: unknown, path: JsPath): unknown =>
  isEmptyValue(getAt(value, path)) ? deleteAt(value, path) : value;

/**
 * Applies the edits and checks, by parsing both texts again, that the file is
 * valid YAML and that its settings changed exactly as `expect` says. The
 * containers in `prune` may or may not be there when empty.
 */
export const applyVerified = (
  text: string,
  edits: ReadonlyArray<Edit>,
  expect: (before: unknown) => unknown,
  prune: ReadonlyArray<JsPath> = [],
): string => {
  if (edits.length === 0) {
    return text;
  }

  const next = applyEdits(text, edits);
  const before = parseYamlMapping(text);
  const after = parseYamlMapping(next);

  if (typeof before === 'string' || typeof after === 'string') {
    throw unsafeLayout(
      `the edit would leave the file ${typeof after === 'string' ? after : before}`,
    );
  }

  const settle = (value: unknown): unknown => prune.reduce(dropIfEmpty, value);

  if (!isDeepStrictEqual(settle(after.toJS()), settle(expect(before.toJS())))) {
    throw unsafeLayout('the edit would not give the intended settings');
  }

  return next;
};
