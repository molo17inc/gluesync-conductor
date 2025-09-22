import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isSslEnabled } from '../utils/ssl';

/**
 * Middleware to redirect HTTP requests to HTTPS
 *
 * This only redirects browser requests, not API clients or local connections,
 * to ensure compatibility with internal services and API clients.
 */
const httpsRedirectMiddleware = (server: Readonly<FastifyInstance>): void => {
  // Skip if SSL is not enabled
  if (!isSslEnabled()) {
    return;
  }

  server.addHook(
    'onRequest',
    async (
      request: Readonly<FastifyRequest>,
      reply: Readonly<FastifyReply>,
      // eslint-disable-next-line consistent-return
    ) => {
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
            // Create HTTPS URL (same port - we're not using dual mode)
            const hostHeader = request.headers.host;
            const httpsUrl = `https://${hostHeader}${request.url}`;

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
};

export default httpsRedirectMiddleware;
