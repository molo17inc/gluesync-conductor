import { FastifyInstance } from 'fastify';
import addAgents from '../functions/agent/addAgents/addAgents';
import getAgentVersion from '../functions/agent/getAgentVersion/getAgentVersion';
import editAgents from '../functions/agent/editAgents/editAgents';

const agentRoutes = async (fastify: Readonly<FastifyInstance>) => {
  fastify.post('/agents', {
    schema: {
      summary: 'Add a list of agents',
      description: 'Agents specifications are written in docker compose file',
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
                nickname: { type: 'string' },
                tag: { type: 'string' },
                environment: {
                  type: 'object',
                  additionalProperties: true,
                },
                labels: {
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
                          mode: { type: 'string' },
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
            results: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  success: { type: 'boolean' },
                  error: { type: 'string' },
                  serviceId: { type: 'string' },
                  service: {
                    type: 'object',
                    nullable: true,
                    additionalProperties: true,
                  },
                },
                required: ['success', 'serviceId'],
              },
            },
            data: {
              type: 'object',
              additionalProperties: true,
            },
          },
          required: ['success', 'results'],
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
          id: { type: 'string', description: 'Agent ID' },
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
            success: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
        502: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
      },
    },
    handler: getAgentVersion,
  });

  fastify.put('/agents', {
    schema: {
      summary: 'Edit a list of agents',
      description: 'Agents specifications are written in docker compose file',
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
                nickname: { type: 'string' },
                tag: { type: 'string' },
                environment: {
                  type: 'object',
                  additionalProperties: true,
                },
                labels: {
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
                          mode: { type: 'string' },
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
            results: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  success: { type: 'boolean' },
                  error: { type: 'string' },
                  serviceId: { type: 'string' },
                  service: {
                    type: 'object',
                    nullable: true,
                    additionalProperties: true,
                  },
                },
                required: ['success', 'serviceId'],
              },
            },
            data: {
              type: 'object',
              additionalProperties: true,
            },
          },
          required: ['success', 'data', 'results'],
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
    handler: editAgents,
  });
};

export default agentRoutes;
