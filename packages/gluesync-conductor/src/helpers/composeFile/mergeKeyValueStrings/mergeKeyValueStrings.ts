import extractKeyValue from '../extractKeyValue/extractKeyValue';

import { composeServiceFieldConfig } from '../../../models/composeFile.model';
import { KeyValueEntry } from '../extractKeyValue/extractKeyValue.model';
import { MergeComposeKeyValueField } from './mergeKeyValueStrings.model';

type LongEntry = Exclude<KeyValueEntry, string>;

// Long-syntax entries are kept as they are. Two of them are the same mount
// when this identity matches, and the later one wins.
const longEntryId = (entry: Readonly<Record<string, any>>): string =>
  `${entry.published ?? entry.source ?? ''}:${entry.target}/${entry.protocol ?? 'tcp'}`;

const splitEntries = (
  input?: ReadonlyArray<KeyValueEntry> | Record<string, any>,
): Readonly<{
  shortEntries?: ReadonlyArray<string> | Record<string, any>;
  longEntries: ReadonlyArray<LongEntry>;
}> =>
  Array.isArray(input)
    ? {
        shortEntries: input.filter(
          (entry): entry is string => typeof entry === 'string',
        ),
        longEntries: input.filter(
          (entry): entry is LongEntry => !!entry && typeof entry === 'object',
        ),
      }
    : { shortEntries: input, longEntries: [] };

const mergeComposeKeyValueField: MergeComposeKeyValueField = (
  field,
  input1,
  input2,
) => {
  const { separator } = composeServiceFieldConfig[field];

  if (!separator) {
    throw new Error(`Separator not defined for field "${field}"`);
  }

  const first = splitEntries(input1);
  const second = splitEntries(input2);

  const allEntries = {
    ...extractKeyValue(separator, first.shortEntries),
    ...extractKeyValue(separator, second.shortEntries),
  };

  const shortEntries = Object.entries(allEntries).map(
    ([key, value]) => `${key}${separator}${value}`,
  );
  const longEntries = [
    ...new Map(
      [...first.longEntries, ...second.longEntries].map(entry => [
        longEntryId(entry),
        entry,
      ]),
    ).values(),
  ];

  return shortEntries.length === 0 && longEntries.length === 0
    ? undefined
    : [...shortEntries, ...longEntries];
};

export default mergeComposeKeyValueField;
