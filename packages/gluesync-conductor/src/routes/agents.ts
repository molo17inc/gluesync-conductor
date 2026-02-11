import { FastifyInstance } from 'fastify';
import getAgentVersion from '../functions/service/getServiceVersion/getServiceVersion';

const agentRoutes = async (fastify: Readonly<FastifyInstance>) => {
  fastify.get('/agents/:id/version/:releaseChannel?', {
    schema: {
      tags: ['agents'],
      summary: 'Get agent version information (deprecated)',
      description:
        '⚠️ This is an old API kept for retro‑compatibility check the new one in services',
      deprecated: true,
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Service ID' },
          releaseChannel: {
            type: 'string',
            enum: ['alpha', 'beta', 'ga'],
            description: 'Release channel (optional, defaults to "ga")',
          },
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
                mandatoryUpdate: { type: 'boolean' },
                servicesToUpdate: {
                  type: 'array',
                  description: 'List of service that needs mandatory update',
                  items: {
                    type: 'string',
                  },
                },
                releaseChannel: { type: 'string' },
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
            details: { type: 'string', nullable: true },
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
