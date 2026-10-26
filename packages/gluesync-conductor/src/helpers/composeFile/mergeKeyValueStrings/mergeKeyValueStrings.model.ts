import { ComposeServiceFieldName } from '../../../models/composeFile.model';
import { KeyValueEntry } from '../extractKeyValue/extractKeyValue.model';

export type MergeComposeKeyValueField = (
  field: ComposeServiceFieldName,
  input1?: ReadonlyArray<KeyValueEntry> | Record<string, any>,
  input2?: ReadonlyArray<KeyValueEntry> | Record<string, any>,
) => ReadonlyArray<KeyValueEntry> | undefined;
