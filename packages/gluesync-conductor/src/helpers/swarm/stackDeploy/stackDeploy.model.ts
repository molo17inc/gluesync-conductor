// Resolves with what the CLI printed, rejects with it when the deploy fails
export type StackDeploy = (
  namespace: string,
  stackFilePath: string,
  envFilePath?: string,
) => Promise<string>;
