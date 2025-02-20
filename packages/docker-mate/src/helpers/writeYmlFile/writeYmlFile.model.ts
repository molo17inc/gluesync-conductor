export type WriteYmlFile = (
  json: Record<string, any>,
  filename?: string,
) => Promise<void>;
