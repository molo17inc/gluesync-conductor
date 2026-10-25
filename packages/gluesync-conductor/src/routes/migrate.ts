import { FastifyInstance } from 'fastify';
import migrateToTwoHandler from '../functions/migrateToTwo/migrateToTwo';
import { requireConfig } from '../security';

const migrateRoutes = async (fastify: Readonly<FastifyInstance>) => {
  fastify.post('/migrate-to-two', {
    schema: {
      tags: ['utility'],
      summary: 'Run migration script to version two',
      description:
        'Runs the migration script `copy-agent-data` located in the container and returns its output',
      response: {
        200: {
          type: 'object',
          required: ['success', 'data'],
          additionalProperties: false,
          properties: {
            success: { type: 'boolean', const: true },
            data: { type: 'string' },
          },
        },
        501: {
          description:
            'Docker Swarm: the migration is not available. `diagnosis` explains why.',
          type: 'object',
          properties: {
            success: { type: 'boolean', const: false },
            error: { type: 'string' },
            details: { type: 'string' },
            diagnosis: { type: 'object', additionalProperties: true },
          },
          additionalProperties: true,
        },
        503: {
          description:
            'Docker is not answering, so compose cannot be told from swarm yet.',
          type: 'object',
          properties: {
            success: { type: 'boolean', const: false },
            error: { type: 'string' },
            details: { type: 'string' },
            diagnosis: { type: 'object', additionalProperties: true },
          },
          additionalProperties: true,
        },
        500: {
          type: 'object',
          required: ['success', 'error'],
          additionalProperties: false,
          properties: {
            success: { type: 'boolean', const: false },
            error: { type: 'string' },
            details: { type: 'string' },
          },
        },
      },
    },
    preHandler: [requireConfig()],
    handler: migrateToTwoHandler,
  });
};

export default migrateRoutes;
