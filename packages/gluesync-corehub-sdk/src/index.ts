/**
 * Gluesync Node.js SDK for CoreHub connection.
 *
 * This SDK provides a client-side interface for interacting with the Gluesync CoreHub 
 * through a WebSocket connection. It implements the complete client-server handshake process 
 * and supports both WS and WSS connections using JKS certificates.
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

// Configure default debug namespace for the SDK
import debug from 'debug';
debug.enable('gluesync:*');

// Export main components
export { GluesyncClient } from './client';
export { WebSocketConnection } from './connection';
export { CoreHubDiscovery, getCorehubAddress } from './discovery';
export { createSslContextFromJks } from './utils';

// Export exceptions
export {
  GluesyncError,
  GluesyncConnectionError,
  GluesyncAuthenticationError,
  GluesyncLicenseError,
  GluesyncSSLError,
  GluesyncTimeoutError,
  GluesyncHandshakeError,
  GluesyncClosedError
} from './exceptions';

// Define package version
export const version = '0.1.0';
