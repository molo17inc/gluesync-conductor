import { FastifyInstance } from 'fastify';
import addServices from '../functions/service/addServices/addServices';
import editServices from '../functions/service/editServices/editServices';
import getServices from '../functions/service/getServices/getServices';
import getAgentVersion from '../functions/service/getServiceVersion/getServiceVersion';

const serviceRoutes = async (fastify: Readonly<FastifyInstance>) => {
  fastify.post('/services', {
    schema: {
      summary: 'Add a list of services',
      description: 'Services specifications are written in docker compose file',
      tags: ['services'],
      querystring: {
        type: 'object',
        properties: {
          raw: { type: 'boolean' },
        },
        required: [],
        additionalProperties: false,
      },
      body: {
        type: 'object',
        properties: {
          services: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                imageName: { type: 'string' },
                type: { type: 'string', enum: ['agent', 'module'] },
                serviceType: { type: 'string', enum: ['target', 'source'] },
                nickname: { type: 'string' },
                // Handled in Service but forced to core-hub version tag
                // tag: { type: 'string' },
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
                healthcheck: {
                  type: 'object',
                },
                dependsOn: {
                  type: 'object',
                },
              },
              required: ['imageName', 'type'],
            },
          },
        },
        required: ['services'],
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
                additionalProperties: true,
              },
            },
          },
          required: ['success', 'results'],
        },
        404: {
          type: 'object',
          properties: {
            success: { type: 'boolean', const: false },
            error: { type: 'string' },
            details: { type: 'string', nullable: true },
          },
          required: ['success', 'error'],
          additionalProperties: false,
        },
        409: {
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
    handler: addServices,
  });

  fastify.put('/services', {
    schema: {
      summary: 'Edit a list of services',
      description: 'Services specifications are written in docker compose file',
      tags: ['services'],
      querystring: {
        type: 'object',
        properties: {
          raw: { type: 'boolean' },
        },
        required: [],
        additionalProperties: false,
      },
      body: {
        type: 'object',
        properties: {
          services: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                serviceId: { type: 'string' },
                imageName: { type: 'string' },
                serviceType: { type: 'string', enum: ['target', 'source'] },
                nickname: { type: 'string' },
                // Handled in Service but forced to core-hub version tag
                // tag: { type: 'string' },
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
                healthcheck: {
                  type: 'object',
                },
                dependsOn: {
                  type: 'object',
                },
              },
              required: ['serviceId', 'imageName'],
            },
          },
        },
        required: ['services'],
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
          },
          required: ['success', 'results'],
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
        409: {
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
    handler: editServices,
  });

  fastify.get('/services', {
    schema: {
      tags: ['services'],
      summary: 'Get service docker configuration',
      description:
        'Retrieve the docker compose configuration for a single service by ID',
      querystring: {
        type: 'object',
        properties: {
          raw: { type: 'boolean' },
          format: { type: 'string', enum: ['string'] },
        },
        required: [],
        additionalProperties: false,
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              oneOf: [
                { type: 'string' },
                {
                  type: 'object',
                  additionalProperties: true,
                },
              ],
            },
          },
          required: ['success', 'data'],
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
    handler: getServices,
  });

  fastify.get('/services/:id', {
    schema: {
      tags: ['services'],
      summary: 'Get service docker configuration',
      description:
        'Retrieve the docker compose configuration for a single service by ID',
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Service ID' },
        },
      },
      querystring: {
        type: 'object',
        properties: {
          raw: { type: 'boolean' },
          format: { type: 'string', enum: ['string'] },
        },
        required: [],
        additionalProperties: false,
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              oneOf: [
                { type: 'string' },
                {
                  type: 'object',
                  additionalProperties: true,
                },
              ],
            },
          },
          required: ['success', 'data'],
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
    handler: getServices,
  });
  fastify.get('/services/:id/version/:releaseChannel?', {
    schema: {
      tags: ['services'],
      summary: 'Get service version information',
      description:
        'Calls the service backoffice.molo17 and returns the service version information',
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
                changelog: { type: 'string' },
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
          additionalProperties: true,
        },
        500: {
          type: 'object',
          properties: {
            success: { type: 'boolean', const: false },
            error: { type: 'string' },
            details: { type: 'string', nullable: true },
          },
          required: ['success', 'error'],
          additionalProperties: true,
        },
      },
    },
    handler: getAgentVersion,
  });
};

export default serviceRoutes;
