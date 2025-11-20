import { FastifyInstance } from 'fastify';
import info from '../functions/info/info';
import version from '../functions/version/version';
import composeToJSON from '../functions/composeToJSON/composeToJSON';

const systemRoutes = async (fastify: Readonly<FastifyInstance>) => {
  fastify.get('/health', {
    schema: {
      tags: ['system'],
      description: 'Health check endpoint',
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'string' },
          },
        },
        500: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
      },
    },
    handler: async (req, reply) => {
      try {
        req.log.debug('Health check OK!');
        reply.send({ success: true, data: 'Health check OK!' });
      } catch (error) {
        req.log.error(error, 'Error');
        reply
          .status(500)
          .send({ success: false, error: 'Health check failed' });
      }
    },
  });

  fastify.get('/compose-to-json', {
    schema: {
      tags: ['system'],
      description: 'Convert compose file to JSON',
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              additionalProperties: true,
              type: 'object',
            },
          },
        },
      },
    },
    handler: composeToJSON,
  });

  fastify.get('/info', {
    schema: {
      tags: ['system'],
      description: 'Get system information',
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              additionalProperties: true,
              type: 'object',
            },
          },
        },
      },
    },
    handler: info,
  });

  fastify.get('/version', {
    schema: {
      tags: ['system'],
      description: 'Get API version',
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              additionalProperties: true,
              type: 'object',
            },
          },
        },
      },
    },
    handler: version,
  });
};

export default systemRoutes;
