/* eslint-disable import/prefer-default-export, functional/no-classes, functional/no-this-expressions -- Error subclass so callers can tell this failure apart */

/** A pairing code that cannot be used; the message is safe to show. */
export class PairingCodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PairingCodeError';
  }
}
