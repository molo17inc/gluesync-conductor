/**
 * This file is part of Gluesync Scheduler Module.
 *
 * Gluesync Scheduler Module is dual-licensed under the following licenses:
 *
 * 1. GNU General Public License (GPL) Version 3
 *    You may use, modify, and distribute this software under the terms of the GPL v3.
 *    See the LICENSE-GPL file or <http://www.gnu.org/licenses/gpl-3.0.html> for details.
 *    This option is available at no cost, but any derivative works must also be licensed under GPL v3.
 *
 * 2. MOLO17 Commercial License
 *    Alternatively, you may use this software under the MOLO17 Commercial License,
 *    which includes a warranty and permits proprietary use. Contact MOLO17 at info@molo17.com
 *    for licensing terms and conditions.
 *
 * You must choose one of these licenses to use this software. Using this software implies
 * acceptance of one of these licenses. See the accompanying LICENSE files or contact
 * MOLO17 for more information.
 *
 * Copyright (C) 2025 MOLO17. All rights reserved.
 */

/**
 * Base exception for Gluesync SDK.
 */
export class GluesyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GluesyncError';
    Object.setPrototypeOf(this, GluesyncError.prototype);
  }
}

/**
 * Exception raised for connection-related errors.
 */
export class GluesyncConnectionError extends GluesyncError {
  constructor(message: string) {
    super(message);
    this.name = 'GluesyncConnectionError';
    Object.setPrototypeOf(this, GluesyncConnectionError.prototype);
  }
}

/**
 * Exception raised for authentication failures.
 */
export class GluesyncAuthenticationError extends GluesyncError {
  constructor(message: string) {
    super(message);
    this.name = 'GluesyncAuthenticationError';
    Object.setPrototypeOf(this, GluesyncAuthenticationError.prototype);
  }
}

/**
 * Exception raised for license-related errors.
 */
export class GluesyncLicenseError extends GluesyncError {
  constructor(message: string) {
    super(message);
    this.name = 'GluesyncLicenseError';
    Object.setPrototypeOf(this, GluesyncLicenseError.prototype);
  }
}

/**
 * Exception raised when operations timeout.
 */
export class GluesyncTimeoutError extends GluesyncConnectionError {
  constructor(message: string) {
    super(message);
    this.name = 'GluesyncTimeoutError';
    Object.setPrototypeOf(this, GluesyncTimeoutError.prototype);
  }
}

/**
 * Exception raised for SSL/TLS certificate issues.
 */
export class GluesyncSSLError extends GluesyncConnectionError {
  constructor(message: string) {
    super(message);
    this.name = 'GluesyncSSLError';
    Object.setPrototypeOf(this, GluesyncSSLError.prototype);
  }
}

/**
 * Exception raised for protocol-related errors.
 */
export class GluesyncProtocolError extends GluesyncError {
  constructor(message: string) {
    super(message);
    this.name = 'GluesyncProtocolError';
    Object.setPrototypeOf(this, GluesyncProtocolError.prototype);
  }
}

/**
 * Exception raised for handshake failures.
 */
export class GluesyncHandshakeError extends GluesyncProtocolError {
  constructor(message: string) {
    super(message);
    this.name = 'GluesyncHandshakeError';
    Object.setPrototypeOf(this, GluesyncHandshakeError.prototype);
  }
}

/**
 * Exception raised when attempting to use a closed connection.
 */
export class GluesyncClosedError extends GluesyncConnectionError {
  constructor(message: string) {
    super(message);
    this.name = 'GluesyncClosedError';
    Object.setPrototypeOf(this, GluesyncClosedError.prototype);
  }
}
