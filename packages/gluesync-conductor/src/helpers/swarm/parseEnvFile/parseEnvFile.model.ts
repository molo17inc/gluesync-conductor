export type ParseEnvFile = (
  content: string,
) => Readonly<Record<string, string>>;
