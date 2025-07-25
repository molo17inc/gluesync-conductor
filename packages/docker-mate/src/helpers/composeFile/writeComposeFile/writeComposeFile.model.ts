export type WriteComposeFile = (
  json: Record<string, any>,
  filename?: string,
) => Promise<void>;
