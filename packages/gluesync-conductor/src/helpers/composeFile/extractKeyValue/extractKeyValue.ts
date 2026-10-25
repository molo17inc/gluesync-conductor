import {
  ComposeServiceFieldName,
  LongPort,
  LongVolume,
} from '../../../models/composeFile.model';
import { getLogger } from '../../../utils/logger';
import {
  CastObject,
  ExtractKeyValue,
  KeyValueEntry,
} from './extractKeyValue.model';

export const castValue = (
  value: any,
): string | boolean | number | null | undefined => {
  const lowerValue = String(value).toLowerCase();

  if (lowerValue === 'true') {
    return true;
  }

  if (lowerValue === 'false') {
    return false;
  }

  if (lowerValue === 'null') {
    return null;
  }

  if (lowerValue === 'undefined') {
    return undefined;
  }

  const num = Number(lowerValue);

  return !Number.isNaN(num) && lowerValue.trim() !== '' ? num : value;
};

export const castObject: CastObject = <T = Record<string, any>>(
  object: Record<string, any>,
) =>
  Object.entries(object).reduce(
    (acc, [key, value]) => ({
      ...acc,
      [key]: castValue(value),
    }),
    {},
  ) as T;

type LongEntryParser = (
  entry: Readonly<Record<string, any>>,
) => readonly [key: string, value: string] | undefined;

// Same key/value a short entry of that field would give, so both syntaxes end
// up in the same shape.
const longEntryParsers: Partial<
  Record<ComposeServiceFieldName, LongEntryParser>
> = {
  volumes: entry => {
    const { source, target, read_only: readOnly } = entry as LongVolume;

    // Without a source (tmpfs, anonymous volume) there is nothing to key on,
    // just like the short `/path` form that is ignored below
    return source && target
      ? [source, `${target}${readOnly ? ':ro' : ''}`]
      : undefined;
  },
  ports: entry => {
    const { target, published, protocol } = entry as LongPort;
    const protocolSuffix = protocol && protocol !== 'tcp' ? `/${protocol}` : '';

    return target === undefined || target === ''
      ? undefined
      : [String(published ?? ''), `${target}${protocolSuffix}`];
  },
};

const fromLongEntry = (
  entry: Readonly<Record<string, any>>,
  field?: ComposeServiceFieldName,
): Partial<Record<string, string | boolean | number | null | undefined>> => {
  const pair = field ? longEntryParsers[field]?.(entry) : undefined;

  if (!pair) {
    getLogger().debug({ field, entry }, 'skipping unsupported compose entry');

    return {};
  }

  return { [pair[0]]: castValue(pair[1]) };
};

const extractKeyValue: ExtractKeyValue = (separator, input, field) => {
  const value = input ?? [];

  return !Array.isArray(value)
    ? value
    : value.reduce((acc, entry: KeyValueEntry) => {
        if (typeof entry !== 'string') {
          return {
            ...acc,
            ...(entry && typeof entry === 'object'
              ? fromLongEntry(entry, field)
              : {}),
          };
        }

        const trimmedEntry = entry.trim();

        // Find the first separator in the entry
        const sepIndex = trimmedEntry.indexOf(separator);

        if (sepIndex === -1) {
          // If the separator doesn't exist, ignore the entry (or you can throw an error)
          return acc;
        }

        const key = trimmedEntry.slice(0, sepIndex).trim();
        const value = castValue(trimmedEntry.slice(sepIndex + 1).trim());

        return {
          ...acc,
          [key]: value,
        };
      }, {});
};

export default extractKeyValue;
