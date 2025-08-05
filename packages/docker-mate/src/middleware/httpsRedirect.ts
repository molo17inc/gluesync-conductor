/**
 * This file is part of Gluesync Container Mate.
 *
 * Gluesync Container Mate is dual-licensed under the following licenses:
 *
 * 1. GNU General Public License (GPL) Version 3
 *    You may use, modify, and distribute this software under the terms of the GPL v3.
 *    This option is available at no cost, but any derivative works must also be licensed under GPL v3.
 *
 * 2. MOLO17 Commercial License
 *    Alternatively, you may use this software under the MOLO17 Commercial License,
 *    which includes a warranty and permits proprietary use. Contact MOLO17 at info@molo17.com
 *    for licensing terms and conditions.
 *
 * Copyright (C) 2025 MOLO17. All rights reserved.
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isSslEnabled } from '../utils/ssl';

/**
 * Middleware to redirect HTTP requests to HTTPS
 *
 * This only redirects browser requests, not API clients or local connections,
 * to ensure compatibility with internal services and API clients.
 */
export default function httpsRedirectMiddleware(server: FastifyInstance): void {
  // Skip if SSL is not enabled
  if (!isSslEnabled()) {
    return;
  }

  server.addHook(
    'onRequest',
    // eslint-disable-next-line consistent-return
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Get protocol from headers or request
      const protocol =
        request.headers['x-forwarded-proto'] || request.protocol || 'http';

      // Only redirect if using HTTP
      if (protocol === 'http') {
        // Check if request is from a browser (not Postman or other API client)
        const userAgent = request.headers['user-agent']?.toLowerCase() || '';
        const isBrowser =
          userAgent.includes('mozilla') ||
          userAgent.includes('chrome') ||
          userAgent.includes('safari') ||
          userAgent.includes('edge');

        // Get client IP from request
        const clientIp = request.ip || '0.0.0.0';
        const isLocal = ['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(
          clientIp,
        );

        // Only redirect browsers, not API clients or local connections
        if (isBrowser && !isLocal) {
          try {
            // Get host from request headers
            const host =
              request.headers.host ||
              `${process.env.HOST || '0.0.0.0'}:${process.env.PORT || '50000'}`;
            const hostname = host.includes(':') ? host.split(':')[0] : host;

            // Create HTTPS URL (same port - we're not using dual mode)
            const port = process.env.PORT || '50000';
            const httpsUrl = `https://${hostname}:${port}${request.url}`;

            server.log.info(
              `Redirecting browser from HTTP to HTTPS: ${httpsUrl}`,
            );
            // Convert numeric status code to string as required by Fastify's redirect method
            return reply.redirect(httpsUrl, 307);
          } catch (error) {
            server.log.error(`Error in redirect middleware: ${error}`);
          }
        }
      }
    },
  );
}
