import fp from 'fastify-plugin';
import {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { ErrorResponse } from '../models/common.model';

type AppError = FastifyError & {
  validation?: unknown;
};

const toErrorResponse = (error: Readonly<AppError>): ErrorResponse => {
  if (error.code === 'FST_ERR_VALIDATION') {
    return { success: false, error: 'Bad Request', details: error.message };
  }

  if (
    error.code === 'FST_ERR_CTP_INVALID_JSON' ||
    /Body is not valid JSON/.test(error.message)
  ) {
    return {
      success: false,
      error: 'Bad Request',
      details: 'Invalid JSON body',
    };
  }

  return {
    success: false,
    error: error.name || 'Error',
    details: error.message,
  };
};

const getStatusCode = (error: Readonly<AppError>): number => {
  if (error.code === 'FST_ERR_VALIDATION') {
    return 400;
  }
  if (error.code === 'FST_ERR_CTP_INVALID_JSON') {
    return 400;
  }
  if (error.statusCode === 404 || error.code === 'FST_ERR_NOT_FOUND') {
    return 404;
  }
  return error.statusCode ?? 500;
};

const errorHandlerPlugin = async (fastify: Readonly<FastifyInstance>) => {
  // Custom 404 response
  fastify.setNotFoundHandler(
    (request: Readonly<FastifyRequest>, reply: Readonly<FastifyReply>) => {
      reply.status(404).send({
        success: false,
        error: 'Not Found',
        details: 'Route not found',
      });
    },
  );

  fastify.setErrorHandler(
    (
      error: Readonly<AppError>,
      request: Readonly<FastifyRequest>,
      reply: Readonly<FastifyReply>,
    ) => {
      const status = getStatusCode(error);
      reply.status(status).send(toErrorResponse(error));
    },
  );
};

export default fp(errorHandlerPlugin);
