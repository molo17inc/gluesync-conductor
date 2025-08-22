export type ExtractKeyValue = (
  separator: string,
  array?: ReadonlyArray<string>,
) => Partial<Record<string, string | boolean | number | null | undefined>>;

export type CastObject = <T = Record<string, any>>(
  object: Record<string, any>,
) => T;
