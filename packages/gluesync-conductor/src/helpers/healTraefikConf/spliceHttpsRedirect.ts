import { Scalar, YAMLMap, isScalar } from 'yaml';

import { parseYamlMapping } from './yamlLikeSource';
import {
  Edit,
  Spliced,
  applyVerified,
  attempt,
  createAt,
  endOf,
  findPair,
  insertLinesAfter,
  isBlockMap,
  isNullValue,
  keyColumn,
  locate,
  pad,
  rangeOf,
  unsafeLayout,
  updateAt,
} from './yamlSplice';

const WEB = 'web';
const WEBSECURE = 'websecure';

const REDIRECT_PATH = [
  'entryPoints',
  WEB,
  'http',
  'redirections',
  'entryPoint',
] as const;

type Leaf = Readonly<{ key: string; value: string | boolean }>;

const LEAVES: ReadonlyArray<Leaf> = [
  { key: 'to', value: WEBSECURE },
  { key: 'scheme', value: 'https' },
  { key: 'permanent', value: true },
];

// A value the customer quoted stays quoted
const written = (leaf: Leaf, old: Readonly<Scalar>): string => {
  if (typeof leaf.value === 'boolean') {
    return String(leaf.value);
  }

  switch (old.type) {
    case 'QUOTE_DOUBLE':
      return `"${leaf.value}"`;
    case 'QUOTE_SINGLE':
      return `'${leaf.value}'`;
    default:
      return leaf.value;
  }
};

// The redirect is there already: only the values that differ change, in place
const mergeIntoRedirect = (
  text: string,
  map: Readonly<YAMLMap>,
): ReadonlyArray<Edit> => {
  const found = LEAVES.map(leaf => ({ leaf, pair: findPair(map, leaf.key) }));

  const replaced = found.flatMap(({ leaf, pair }): ReadonlyArray<Edit> => {
    if (!pair) {
      return [];
    }

    const old = pair.value;

    if (!isScalar(old) || isNullValue(old)) {
      throw unsafeLayout(`entryPoint.${leaf.key} is not a plain value`);
    }

    if (old.value === leaf.value) {
      return [];
    }

    const [start] = rangeOf(old);

    return [{ start, end: endOf(text, old), insert: written(leaf, old) }];
  });

  const missing = found.filter(({ pair }) => !pair).map(({ leaf }) => leaf);
  const column = keyColumn(text, map.items[0]);

  return missing.length === 0
    ? replaced
    : [
        ...replaced,
        insertLinesAfter(
          text,
          endOf(text, map),
          missing.map(({ key, value }) => `${pad(column)}${key}: ${value}`),
        ),
      ];
};

const spliceRedirect = (text: string): string => {
  const doc = parseYamlMapping(text);

  if (typeof doc === 'string') {
    throw unsafeLayout(`the file is ${doc}`);
  }

  const { pair } = locate(doc, text, REDIRECT_PATH);
  const there = pair !== undefined && !isNullValue(pair.value);

  if (there && !isBlockMap(pair.value)) {
    throw unsafeLayout(
      'entryPoints.web.http.redirections.entryPoint is not a block mapping',
    );
  }

  const edits =
    there && isBlockMap(pair.value)
      ? mergeIntoRedirect(text, pair.value)
      : [
          createAt(doc, text, REDIRECT_PATH, column =>
            LEAVES.map(({ key, value }) => `${pad(column)}${key}: ${value}`),
          ),
        ];

  return applyVerified(text, edits, js =>
    updateAt(js, REDIRECT_PATH, current => ({
      ...(typeof current === 'object' && current !== null ? current : {}),
      ...Object.fromEntries(LEAVES.map(({ key, value }) => [key, value])),
    })),
  );
};

/**
 * The traefik.yml text with the `web` entry point's http to https redirect in
 * place. Only the bytes of the redirect change (missing levels are added, a
 * value that differs is replaced where it stands); comments, spacing, key
 * order, line ends and every other setting stay as they are. A layout that
 * cannot be spliced safely gives the reason instead.
 */
const spliceHttpsRedirect = (text: string): Spliced =>
  attempt(() => spliceRedirect(text));

export default spliceHttpsRedirect;
