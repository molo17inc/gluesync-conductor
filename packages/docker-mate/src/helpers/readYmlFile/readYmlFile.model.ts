export type ReadYmlFile = <T = any>(
  filename?: string,
) => Promise<Record<string, T>>;
