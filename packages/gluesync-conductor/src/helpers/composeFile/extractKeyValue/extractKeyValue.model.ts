export type ExtractKeyValue = (
  separator: string,
  value?: ReadonlyArray<string> | Record<string, any>,
) => Partial<Record<string, string | boolean | number | null | undefined>>;

export type CastObject = <T = Record<string, any>>(
  object: Record<string, any>,
) => T;
