import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import {
  Document,
  SchemaOptions,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  stringify,
} from 'yaml';
import { WriteYmlFile } from './writeYmlFile.model';
import getRootPath from '../../getRootPath/getRootPath';
import { isMainComposeFile } from '../../composeFile/composeBackup/composeBackup';
import ensureValidCompose from '../../composeFile/ensureValidCompose/ensureValidCompose';
import inspectCompose from '../../composeFile/inspectCompose/inspectCompose';
import safeWriteFile from '../safeWriteFile/safeWriteFile';
import { UnsafeWriteError } from '../safeWriteFile/safeWriteFile.errors';

const NUMBER_TAGS: ReadonlyArray<string> = [
  'tag:yaml.org,2002:int',
  'tag:yaml.org,2002:float',
];

// The library writes every number back from its value, so an untouched
// `mode: 0444` (decimal 444 for YAML 1.2) would come out as `444`, which
// Docker reads as another permission. A number that was parsed keeps its source.
const keepNumberSource: NonNullable<SchemaOptions['customTags']> = tags =>
  (tags as ReadonlyArray<any>).map(tag =>
    NUMBER_TAGS.includes(tag.tag) && typeof tag.stringify === 'function'
      ? {
          ...tag,
          stringify: (node: any, ctx: any, onComment: any, onChompKeep: any) =>
            typeof node.source === 'string' &&
            Number(node.source) === node.value
              ? node.source
              : tag.stringify(node, ctx, onComment, onChompKeep),
        }
      : tag,
  ) as any;

// lineWidth 0: no folding, so a long label stays on its line instead of being
// wrapped (same value, but a noisy diff for a customer comparing their kit)
const WRITE_OPTIONS = { indent: 2, lineWidth: 0 } as const;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const keyOf = (key: unknown): unknown => (isScalar(key) ? key.value : key);

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

  // Same length: only the elements that differ are touched. Replacing the
  // whole sequence re-serialises its unchanged siblings, and a secret's
  // `mode: 0444` (read as decimal 444 by YAML 1.2) would come back as `444`.
  if (
    isSeq(current) &&
    Array.isArray(value) &&
    current.items.length === value.length
  ) {
    value.forEach((child, index) => syncNode(doc, [...path, index], child));
    return;
  }

  const currentValue = isNode(current) ? current.toJSON() : current;
  if (isDeepStrictEqual(currentValue, value)) {
    return;
  }
  doc.setIn(path, value);
};

const withoutUndefined = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(withoutUndefined);
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .map(([key, child]) => [key, withoutUndefined(child)]),
    );
  }
  return value;
};

const readExisting = async (path: string): Promise<Document | null> => {
  // The compose file is never taken for "nothing there" when it is damaged:
  // it is restored from the last-good copy, or the write fails.
  if (isMainComposeFile(path)) {
    await ensureValidCompose(path);
  }
  try {
    const doc = parseDocument(await readFile(path, 'utf8'), {
      customTags: keepNumberSource,
    });
    return doc.errors.length === 0 && doc.contents ? doc : null;
  } catch {
    return null;
  }
};

// What is about to be written must read back as exactly `json`, with services.
const assertReadsBackAs =
  (path: string, json: unknown) =>
  (content: Buffer): void => {
    const { problem, value } = inspectCompose(content.toString('utf8'));
    if (problem) {
      throw new UnsafeWriteError(
        path,
        `the result is not a usable compose file (${problem})`,
      );
    }
    if (!isDeepStrictEqual(value, withoutUndefined(json))) {
      throw new UnsafeWriteError(
        path,
        'the serialised YAML does not match what was asked',
      );
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

  const validate = assertReadsBackAs(path, json);

  // Merging needs a mapping on both sides (always the case for compose files).
  if (!existing || !isMap(existing.contents) || !isPlainObject(json)) {
    await safeWriteFile(path, stringify(json, WRITE_OPTIONS), { validate });
    return;
  }

  syncNode(existing, [], json);
  await safeWriteFile(path, existing.toString(WRITE_OPTIONS), { validate });
};

export default writeYmlFile;
