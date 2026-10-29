import { STATUS_CODES } from 'node:http';
import fp from 'fastify-plugin';
import {
  FastifyError,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { ErrorResponse } from '../models/common.model';

const INTERNAL_SERVER_ERROR = 500;

const isHttpError = (statusCode: unknown): statusCode is number =>
  Number.isInteger(statusCode) &&
  (statusCode as number) >= 400 &&
  (statusCode as number) <= 599;

// Fastify sets `statusCode` on its own errors (400 for validation and invalid
// JSON, 413 for a too large body, ...). Anything else that was thrown is a 500.
const getStatusCode = (error: Readonly<FastifyError>): number =>
  isHttpError(error.statusCode) ? error.statusCode : INTERNAL_SERVER_ERROR;

const getDetails = (error: Readonly<FastifyError>): string =>
  error.code === 'FST_ERR_CTP_INVALID_JSON' ||
  /Body is not valid JSON/.test(error.message)
    ? 'Invalid JSON body'
    : error.message;

const toErrorResponse = (
  error: Readonly<FastifyError>,
  status: number,
): ErrorResponse => ({
  success: false,
  error: STATUS_CODES[status] ?? 'Error',
  details: getDetails(error),
});

// Same levels as Fastify's default handler: 4xx is the client's doing (info),
// 5xx is ours and has to reach the log with its stack.
const logError = (
  request: Readonly<FastifyRequest>,
  error: Readonly<FastifyError>,
  status: number,
): void => {
  if (status >= INTERNAL_SERVER_ERROR) {
    request.log.error({ error }, error.message);
  } else {
    request.log.info({ error }, error.message);
  }
};

const errorHandlerPlugin: FastifyPluginCallback = (fastify, _options, done) => {
  // Custom 404 response
  fastify.setNotFoundHandler(
    (_request: Readonly<FastifyRequest>, reply: Readonly<FastifyReply>) => {
      reply.status(404).send({
        success: false,
        error: 'Not Found',
        details: 'Route not found',
      });
    },
  );

  fastify.setErrorHandler(
    (
      error: Readonly<FastifyError>,
      request: Readonly<FastifyRequest>,
      reply: Readonly<FastifyReply>,
    ) => {
      const status = getStatusCode(error);
      logError(request, error, status);
      reply.status(status).send(toErrorResponse(error, status));
    },
  );

  done();
};

export default fp(errorHandlerPlugin, { name: 'conductor-error-handler' });
