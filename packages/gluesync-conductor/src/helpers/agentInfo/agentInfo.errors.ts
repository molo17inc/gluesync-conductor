/* eslint-disable functional/no-classes, functional/no-this-expressions -- Error subclass so callers can tell this answer apart from a failed request */

/**
 * The MOLO17 update service answered that it publishes no image by this name
 * (HTTP 404). It is an answer, not a failure to reach the service: a custom
 * build (`core-hub-internal`), a service that is not MOLO17's, a Windows
 * variant that was never released.
 */
export class ImageNotPublishedError extends Error {
  readonly imageName: string;

  constructor(imageName: string) {
    super(`Image "${imageName}" is not published by the MOLO17 update service`);
    this.name = 'ImageNotPublishedError';
    this.imageName = imageName;
  }
}

export const isImageNotPublished = (
  error: unknown,
): error is ImageNotPublishedError => error instanceof ImageNotPublishedError;
