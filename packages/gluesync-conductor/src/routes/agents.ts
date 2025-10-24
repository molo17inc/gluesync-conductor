import { FastifyInstance } from 'fastify';
import getAgentVersion from '../functions/agent/getAgentVersion/getAgentVersion';

const agentRoutes = async (fastify: Readonly<FastifyInstance>) => {
  fastify.get('/agents/:id/version', {
    schema: {
      tags: ['agents'],
      summary: 'Get agent version information',
      description:
        'Calls the service backoffice.molo17 and returns the agent version information',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Service ID' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              additionalProperties: true,
              type: 'object',
              properties: {
                currentVersion: { type: 'string' },
                latestVersionAlpha: { type: 'string' },
                latestVersionBeta: { type: 'string' },
                latestVersionGA: { type: 'string' },
              },
            },
          },
        },
        404: {
          type: 'object',
          properties: {
            success: { type: 'boolean', const: false },
            error: { type: 'string' },
          },
          required: ['success', 'error'],
          additionalProperties: false,
        },
        502: {
          type: 'object',
          properties: {
            success: { type: 'boolean', const: false },
            error: { type: 'string' },
          },
          required: ['success', 'error'],
          additionalProperties: false,
        },
        500: {
          type: 'object',
          properties: {
            success: { type: 'boolean', const: false },
            error: { type: 'string' },
            details: { type: 'string', nullable: true },
          },
          required: ['success', 'error'],
          additionalProperties: false,
        },
      },
    },
    handler: getAgentVersion,
  });
};

export default agentRoutes;
