// Resolves with the logs, stdout and stderr together; rejects when the CLI fails
export type ServiceLogs = (
  fullName: string,
  sinceHours: number,
  tail?: number,
) => Promise<string>;
