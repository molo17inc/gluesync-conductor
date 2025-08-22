import { ComposeServiceFieldName } from '../../../models/composeFile.model';

export type MergeComposeKeyValueField = (
  field: ComposeServiceFieldName,
  input1?: ReadonlyArray<string>,
  input2?: ReadonlyArray<string>,
) => ReadonlyArray<string> | undefined;
