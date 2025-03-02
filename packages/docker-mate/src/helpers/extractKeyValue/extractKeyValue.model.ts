export type ExtractKeyValue = (
  array?: ReadonlyArray<string>,
) => Partial<Record<string, string | boolean | number | null | undefined>>;
