export type RunDockerCliOptions = Readonly<{
  cwd?: string;
  // Replaces the environment of the child (default: this process's)
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}>;

export type DockerCliResult = Readonly<{
  exitCode: number;
  // stdout and stderr in the order they arrived
  output: string;
}>;

// Resolves with the exit code, whatever it is. Rejects only when the CLI cannot be started.
export type RunDockerCli = (
  args: ReadonlyArray<string>,
  options?: RunDockerCliOptions,
) => Promise<DockerCliResult>;
