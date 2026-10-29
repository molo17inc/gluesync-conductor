import type { RawComposeFile } from '../../models/composeFile.model';
import {
  LabelSet,
  TRAEFIK_ENABLE,
  classifyLegacyServiceLabel,
  classifyProxyLabel,
  legacyProxyLabels,
  targetLabels,
} from './errorPagesWiring';
import type { LabelsInput } from './healProxyErrorPages.model';

type ComposeJson = Partial<RawComposeFile>;
type Services = NonNullable<ComposeJson['services']>;
type Service = Services[string];

type LabelContainer = ReadonlyArray<unknown> | Record<string, unknown>;

// A label value of the map form: text, a number or a boolean; anything else is no value.
const labelValue = (value: unknown): string =>
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'boolean'
    ? String(value)
    : '';

const isList = (labels: LabelsInput): labels is ReadonlyArray<unknown> =>
  Array.isArray(labels);

const splitEntry = (entry: unknown): readonly [string, string] | null => {
  if (typeof entry !== 'string') {
    return null;
  }

  const at = entry.indexOf('=');

  return at < 0 ? [entry, ''] : [entry.slice(0, at), entry.slice(at + 1)];
};

/** The labels as key -> value, whichever form the file uses. */
export const labelEntries = (
  labels: LabelsInput,
): ReadonlyArray<readonly [string, string]> => {
  if (isList(labels)) {
    return labels
      .map(splitEntry)
      .filter((entry): entry is readonly [string, string] => entry !== null);
  }

  return labels
    ? Object.entries(labels).map(
        ([key, value]) => [key, labelValue(value)] as const,
      )
    : [];
};

export const labelMap = (labels: LabelsInput): Record<string, string> =>
  Object.fromEntries(labelEntries(labels));

export const labelsOf = (service: Service | undefined): LabelsInput =>
  service?.labels as LabelsInput;

const joinEntry = (key: string, value: string): string => `${key}=${value}`;

/** Appends `additions` whose key is not there yet, in the form the file uses. */
export const appendLabels = (
  labels: LabelsInput,
  additions: LabelSet,
): ReadonlyArray<string> | Record<string, unknown> => {
  const present = new Set(labelEntries(labels).map(([key]) => key));
  const missing = Object.entries(additions).filter(
    ([key]) => !present.has(key),
  );

  if (labels && !isList(labels)) {
    return { ...labels, ...Object.fromEntries(missing) };
  }

  return [
    ...((labels as ReadonlyArray<string> | undefined | null) ?? []),
    ...missing.map(([key, value]) => joinEntry(key, value)),
  ];
};

/**
 * Keeps the labels `keep` says yes to, in the form the file uses. A label this
 * code cannot read (a list entry that is not a string) is always kept.
 */
export const filterLabels = (
  labels: LabelsInput,
  keep: (key: string, value: string) => boolean,
): LabelContainer | undefined => {
  if (!labels) {
    return undefined;
  }

  if (isList(labels)) {
    return labels.filter(entry => {
      const split = splitEntry(entry);

      return split === null || keep(split[0], split[1]);
    });
  }

  return Object.fromEntries(
    Object.entries(labels).filter(([key, value]) =>
      keep(key, labelValue(value)),
    ),
  );
};

const isEmptyLabels = (labels: LabelContainer | undefined): boolean =>
  labels === undefined ||
  (isList(labels) ? labels.length === 0 : Object.keys(labels).length === 0);

const withServiceLabels = (
  composeJson: ComposeJson,
  name: string,
  labels: LabelContainer | undefined,
): ComposeJson => {
  const service = (composeJson.services?.[name] ?? {}) as Record<
    string,
    unknown
  >;
  const rest = Object.fromEntries(
    Object.entries(service).filter(([key]) => key !== 'labels'),
  );

  return {
    ...composeJson,
    services: {
      ...composeJson.services,
      [name]: (isEmptyLabels(labels)
        ? rest
        : { ...rest, labels }) as unknown as Service,
    },
  };
};

const otherTraefikLabelRemains = (
  labels: LabelContainer | undefined,
): boolean =>
  labelEntries(labels as LabelsInput).some(
    ([key]) => key.startsWith('traefik.') && key !== TRAEFIK_ENABLE,
  );

/**
 * Drops from the reverse-proxy's labels what `drop` marks, then
 * `traefik.enable=true` when no other Traefik label needs it any more.
 */
const dropProxyLabels = (
  labels: LabelsInput,
  drop: (key: string, value: string) => boolean,
): LabelContainer | undefined => {
  const remaining = filterLabels(
    labels,
    (key, value) => key === TRAEFIK_ENABLE || !drop(key, value),
  );
  const enable = labelMap(remaining as LabelsInput)[TRAEFIK_ENABLE];

  return enable === 'true' && !otherTraefikLabelRemains(remaining)
    ? filterLabels(remaining, key => key !== TRAEFIK_ENABLE)
    : remaining;
};

const isTargetOnly = (
  key: string,
  value: string,
  isWindows: boolean,
): boolean => {
  const kind = classifyProxyLabel(
    key,
    value,
    targetLabels(isWindows),
    legacyProxyLabels(isWindows),
  );

  return kind === 'target' || kind === 'both';
};

const isLegacyOnly = (
  key: string,
  value: string,
  isWindows: boolean,
): boolean => {
  const kind = classifyProxyLabel(
    key,
    value,
    targetLabels(isWindows),
    legacyProxyLabels(isWindows),
  );

  return kind === 'legacy';
};

/** Target labels added to the reverse-proxy service. */
export const addTargetLabels = (
  composeJson: ComposeJson,
  proxy: string,
  isWindows: boolean,
): ComposeJson =>
  withServiceLabels(
    composeJson,
    proxy,
    appendLabels(
      labelsOf(composeJson.services?.[proxy]),
      targetLabels(isWindows),
    ),
  );

/** Target and v0.0.286 labels removed from the reverse-proxy, nothing else. */
export const removeProxyLabels = (
  composeJson: ComposeJson,
  proxy: string,
  isWindows: boolean,
): ComposeJson =>
  withServiceLabels(
    composeJson,
    proxy,
    dropProxyLabels(
      labelsOf(composeJson.services?.[proxy]),
      (key, value) =>
        isTargetOnly(key, value, isWindows) ||
        isLegacyOnly(key, value, isWindows),
    ),
  );

const isLegacyServiceLabel = (key: string, value: string): boolean =>
  classifyLegacyServiceLabel(key, value).exact;

/** What v0.0.286 added to the services other than the reverse-proxy. */
export const removeLegacyServiceLabels = (
  composeJson: ComposeJson,
  proxy: string,
): ComposeJson =>
  Object.keys(composeJson.services ?? {})
    .filter(name => name !== proxy)
    .filter(name =>
      labelEntries(labelsOf(composeJson.services?.[name])).some(
        ([key, value]) => isLegacyServiceLabel(key, value),
      ),
    )
    .reduce(
      (current, name) =>
        withServiceLabels(
          current,
          name,
          filterLabels(
            labelsOf(current.services?.[name]),
            (key, value) => !isLegacyServiceLabel(key, value),
          ),
        ),
      composeJson,
    );

/** Everything removed: target and v0.0.286 labels, on every service. */
export const removeAllLabels = (
  composeJson: ComposeJson,
  proxy: string,
  isWindows: boolean,
): ComposeJson =>
  removeLegacyServiceLabels(
    removeProxyLabels(composeJson, proxy, isWindows),
    proxy,
  );
