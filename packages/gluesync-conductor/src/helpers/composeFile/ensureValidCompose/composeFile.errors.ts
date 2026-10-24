/* eslint-disable import/prefer-default-export, functional/no-classes, functional/no-this-expressions -- Error subclass so callers can tell this failure apart */

/** The compose file on disk is unusable and there is no valid backup to restore. */
export class ComposeFileCorruptError extends Error {
  readonly path: string;

  /** What is wrong with the file (empty, not valid YAML, ...), as detected. */
  readonly problem: string;

  constructor(path: string, reason: string) {
    super(`docker-compose.yml is empty or corrupt (${reason}): ${path}`);
    this.name = 'ComposeFileCorruptError';
    this.path = path;
    this.problem = reason;
  }
}
