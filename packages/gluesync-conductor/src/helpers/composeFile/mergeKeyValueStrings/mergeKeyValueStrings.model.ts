import { ComposeServiceFieldName } from '../../../models/composeFile.model';

export type MergeComposeKeyValueField = (
  field: ComposeServiceFieldName,
  input1?: ReadonlyArray<string> | Record<string, any>,
  input2?: ReadonlyArray<string> | Record<string, any>,
) => ReadonlyArray<string> | undefined;
