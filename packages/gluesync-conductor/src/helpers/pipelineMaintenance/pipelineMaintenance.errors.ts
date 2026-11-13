/* eslint-disable max-classes-per-file, functional/no-classes, functional/no-this-expressions -- Error subclasses are how callers tell these failures apart */

/**
 * Core Hub did not answer at all: no address, no token yet (the SDK connects
 * again after Core Hub restarts), refused or timed out. Nothing is known about
 * the pipelines.
 */
export class CoreHubUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoreHubUnreachableError';
  }
}

/** Core Hub answered with an error status (or with something unexpected). */
export class CoreHubApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'CoreHubApiError';
    this.status = status;
  }
}

/**
 * The update was refused before any image changed: the running pipelines could
 * not be put in maintenance mode (drain timeout, or Core Hub refused). The
 * ones already paused have been resumed.
 */
export class UpdateRefusedByPipelinesError extends Error {
  readonly statusCode: number;

  readonly title: string;

  readonly resumed: ReadonlyArray<string>;

  readonly notResumed: ReadonlyArray<string>;

  constructor(
    statusCode: number,
    title: string,
    details: string,
    outcome: Readonly<{
      resumed: ReadonlyArray<string>;
      notResumed: ReadonlyArray<string>;
    }>,
  ) {
    super(details);
    this.name = 'UpdateRefusedByPipelinesError';
    this.statusCode = statusCode;
    this.title = title;
    this.resumed = outcome.resumed;
    this.notResumed = outcome.notResumed;
  }
}
