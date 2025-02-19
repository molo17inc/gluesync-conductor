export type ReadComposeFile = (
  json: Record<string, any>,
  filename?: string,
) => Promise<void>;
