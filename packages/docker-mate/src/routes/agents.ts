import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import addAgents from '../functions/agent/addAgents/addAgents';

const agentRoutes = async (
  fastify: FastifyInstance,
  options: FastifyPluginOptions,
) => {
  fastify.post('/agents', {
    schema: {
      description: 'Add agents',
      tags: ['agents'],
      body: {
        type: 'object',
        properties: {
          agents: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                imageName: { type: 'string' },
                type: { type: 'string', enum: ['target', 'source'] },
                name: { type: 'string' },
                tag: { type: 'string' },
                environment: {
                  type: 'object',
                  additionalProperties: true,
                },
                ports: {
                  type: 'array',
                  items: {
                    anyOf: [
                      {
                        type: 'object',
                        properties: {
                          host: { type: 'string' },
                          container: { type: 'string' },
                          protocol: { type: 'string' },
                        },
                        required: ['host', 'container'],
                      },
                      {
                        type: 'string',
                      },
                    ],
                  },
                },
                volumes: {
                  type: 'array',
                  items: {
                    anyOf: [
                      {
                        type: 'object',
                        properties: {
                          host: { type: 'string' },
                          container: { type: 'string' },
                          opts: { type: 'string' },
                        },
                        required: ['host', 'container'],
                      },
                      {
                        type: 'string',
                      },
                    ],
                  },
                },
                reservations: {
                  type: 'object',
                },
                limits: {
                  type: 'object',
                },
              },
              required: ['imageName', 'type'],
            },
          },
        },
        required: ['agents'],
      },
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
        404: {
          type: 'object',
          properties: {
            success: { type: 'boolean', default: false },
            error: { type: 'string' },
          },
        },
      },
    },
    handler: addAgents,
  });
};

export default agentRoutes;
