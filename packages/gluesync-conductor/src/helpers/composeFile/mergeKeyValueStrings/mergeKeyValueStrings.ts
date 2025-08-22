import extractKeyValue from '../extractKeyValue/extractKeyValue';

import { composeServiceFieldConfig } from '../../../models/composeFile.model';
import { MergeComposeKeyValueField } from './mergeKeyValueStrings.model';

const mergeComposeKeyValueField: MergeComposeKeyValueField = (
  field,
  input1,
  input2,
) => {
  const { separator } = composeServiceFieldConfig[field];

  if (!separator) {
    throw new Error(`Separator not defined for field "${field}"`);
  }

  const allEntries = {
    ...extractKeyValue(separator, input1),
    ...extractKeyValue(separator, input2),
  };

  const entries = Object.entries(allEntries);

  if (entries.length === 0) {
    return undefined;
  }

  return entries.map(([key, value]) => `${key}${separator}${value}`);
};

export default mergeComposeKeyValueField;
