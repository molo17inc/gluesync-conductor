import { readFile, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import {
  Document,
  YAMLSeq,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  stringify,
} from 'yaml';
import { WriteYmlFile } from './writeYmlFile.model';
import getRootPath from '../../getRootPath/getRootPath';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const keyOf = (key: unknown): unknown => (isScalar(key) ? key.value : key);

const isPrimitive = (value: unknown): boolean =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value);

// Indexes of `have` that `want` keeps, in order (greedy): what is left of
// `want` after them is new.
const keptIndexes = (
  have: ReadonlyArray<unknown>,
  want: ReadonlyArray<unknown>,
): ReadonlyArray<number> =>
  want.reduce<
    Readonly<{ at: number; done: boolean; kept: ReadonlyArray<number> }>
  >(
    (acc, item) => {
      const found = acc.done ? -1 : have.indexOf(item, acc.at);
      return found < 0
        ? { ...acc, done: true }
        : { at: found + 1, done: false, kept: [...acc.kept, found] };
    },
    { at: 0, done: false, kept: [] },
  ).kept;

// A list of plain values that lost some entries and/or gained some at the end
// (a label list getting labels, or losing them): the entries that stay are not
// touched, so their comments and quoting stay too. Returns whether it applied.
const editScalarList = (
  doc: Readonly<Document>,
  current: Readonly<YAMLSeq>,
  value: ReadonlyArray<unknown>,
): boolean => {
  const have = current.items.map(item => (isScalar(item) ? item.value : item));
  const plain = current.items.every(isScalar) && value.every(isPrimitive);

  if (!plain) {
    return false;
  }

  const kept = keptIndexes(have, value);

  have
    .map((_, index) => index)
    .filter(index => !kept.includes(index))
    .reverse()
    .forEach(index => current.delete(index));
  value.slice(kept.length).forEach(item => current.add(doc.createNode(item)));

  return true;
};

// Applies `value` at `path`, leaving every node whose content is unchanged as
// it was, so its comments, anchors and formatting survive.
const syncNode = (
  doc: Readonly<Document>,
  path: ReadonlyArray<unknown>,
  value: unknown,
): void => {
  const current = doc.getIn(path, true);

  if (isMap(current) && isPlainObject(value)) {
    // Undefined values are dropped, as a plain stringify would do.
    current.items
      .map(pair => keyOf(pair.key))
      .filter(key => value[String(key)] === undefined)
      .forEach(key => doc.deleteIn([...path, key]));
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .forEach(([key, child]) => syncNode(doc, [...path, key], child));
    return;
  }

  if (
    isSeq(current) &&
    Array.isArray(value) &&
    editScalarList(doc, current, value)
  ) {
    return;
  }

  const currentValue = isNode(current) ? current.toJSON() : current;
  if (isDeepStrictEqual(currentValue, value)) {
    return;
  }
  doc.setIn(path, value);
};

const readExisting = async (path: string): Promise<Document | null> => {
  try {
    const doc = parseDocument(await readFile(path, 'utf8'));
    return doc.errors.length === 0 && doc.contents ? doc : null;
  } catch {
    return null;
  }
};

/**
 * Writes `json` as YAML. When the file already exists, the change is applied
 * to its parsed document instead of re-serialising from scratch: a plain
 * stringify dropped every comment in customers' compose files (including the
 * kit's own header) on the conductor's first start and on every update.
 */
const writeYmlFile: WriteYmlFile = async (json, filename) => {
  const path = getRootPath({ filename });
  const existing = await readExisting(path);

  // Merging needs a mapping on both sides (always the case for compose files).
  if (!existing || !isMap(existing.contents) || !isPlainObject(json)) {
    await writeFile(path, stringify(json, { indent: 2 }), 'utf8');
    return;
  }

  syncNode(existing, [], json);
  await writeFile(path, existing.toString({ indent: 2 }), 'utf8');
};

export default writeYmlFile;
