import { FastifyInstance } from 'fastify';
import info from '../functions/info/info';
import version from '../functions/version/version';
import composeToJSON from '../functions/composeToJSON/composeToJSON';
import connectivity from '../functions/system/connectivity/connectivity';
import { requireConfig } from '../security';

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

  fastify.get('/connectivity', {
    preHandler: [requireConfig()],
    schema: {
      tags: ['system'],
      summary: 'Check connectivity to MOLO17 services',
      description:
        'Probes the proxy, the internet, the MOLO17 backoffice, the image registry and the public status feed from this host, ' +
        'then returns a diagnosis: who is at fault (customer network, MOLO17, or this install) and what to do. ' +
        'Results are cached for a short time; `refresh` forces a new run within a minimum interval.',
      querystring: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['ota'], default: 'ota' },
          refresh: { type: 'boolean', default: false },
        },
        additionalProperties: false,
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              description:
                'Diagnosis contract v1 (see contracts/diagnosis.v1.schema.json)',
              additionalProperties: true,
            },
          },
        },
      },
    },
    handler: connectivity,
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
