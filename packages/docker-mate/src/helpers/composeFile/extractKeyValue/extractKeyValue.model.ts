export type ExtractKeyValue = (
  separator: string,
  array?: ReadonlyArray<string>,
) => Partial<Record<string, string | boolean | number | null | undefined>>;
