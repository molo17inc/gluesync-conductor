import type Docker from 'dockerode';

export type ExportSwarmServiceLogsOptions = Readonly<{
  outputDirectory: string;
  sinceHours: number;
  // Lines per service; all of them when absent
  tailLines?: number;
}>;

// Writes one file per service of the stack and answers the paths of the files
export type ExportSwarmServiceLogs = (
  docker: Readonly<Docker>,
  namespace: string,
  options: ExportSwarmServiceLogsOptions,
) => Promise<ReadonlyArray<string>>;
