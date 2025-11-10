import { FastifyInstance } from 'fastify';
import listContainers from '../functions/container/listContainers/listContainers';
import doContainersAction from '../functions/container/doContainersAction/doContainersAction';
import { containerActions } from '../models/conductor.model';

const containerRoutes = async (fastify: Readonly<FastifyInstance>) => {
  // Register ComposeFile schema
  fastify.addSchema({
    $id: 'ComposeFile',
    additionalProperties: true,
    type: 'object',
    properties: {
      name: { type: 'string' },
      services: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          properties: {
            image: { type: 'string' },
            container_name: { type: 'string' },
            restart: { type: 'string' },
            environment: { type: 'array', items: { type: 'string' } },
            ports: { type: 'array', items: { type: 'string' } },
            volumes: { type: 'array', items: { type: 'string' } },
            labels: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  });

  fastify.get('/containers', {
    schema: {
      tags: ['containers'],
      summary: 'List all Docker containers',
      description:
        'Retrieves a comprehensive list of all Docker containers with their current status, configuration, and system information including CPU and memory details.',
      querystring: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['agent', 'module', 'unknown', 'all'],
            description: 'Filter containers by type',
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                systemInfo: {
                  type: 'object',
                  properties: {
                    ncpu: { type: 'number' },
                    memTotal: { type: 'number' },
                  },
                },
                containers: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      type: {
                        type: 'string',
                        enum: ['agent', 'module', 'unknown'],
                      },
                      persisted: { type: 'boolean' },

                      service: {
                        type: 'object',
                        properties: {
                          image: { type: 'string' },
                          container_name: { type: 'string' },
                          restart: { type: 'string' },
                          deploy: {
                            type: 'object',
                            properties: {
                              resources: {
                                type: 'object',
                                properties: {
                                  reservations: {
                                    type: 'object',
                                    properties: {
                                      cpus: { type: 'number' },
                                      memory: { type: 'string' },
                                    },
                                  },
                                  limits: {
                                    type: 'object',
                                    properties: {
                                      cpus: { type: 'number' },
                                      memory: { type: 'string' },
                                    },
                                  },
                                },
                              },
                            },
                          },
                          labels: {
                            type: 'object',
                            additionalProperties: true,
                          },
                          environment: {
                            type: 'object',
                            additionalProperties: true,
                          },
                          ports: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                host: { type: 'string' },
                                container: { type: 'string' },
                                protocol: {
                                  type: 'string',
                                  enum: ['tcp', 'udp'],
                                },
                              },
                            },
                          },
                          volumes: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                host: { type: 'string' },
                                container: { type: 'string' },
                                opts: { type: 'string', enum: ['rw', 'ro'] },
                              },
                            },
                          },
                        },
                      },

                      info: {
                        type: 'object',
                        properties: {
                          id: { type: 'string' },
                          name: { type: 'string' },
                          image: { type: 'string' },
                          imageID: { type: 'string' },
                          tag: {
                            description:
                              'Deprecated: use parsedImage.tag instead',
                            deprecated: true,
                          },
                          command: { type: 'string' },
                          created: { type: 'number' },
                          state: { type: 'string' },
                          status: { type: 'string' },
                          ports: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                ip: { type: 'string' },
                                privatePort: { type: 'number' },
                                publicPort: { type: 'number' },
                                type: { type: 'string' },
                              },
                            },
                          },
                          labels: {
                            type: 'object',
                            additionalProperties: true,
                          },
                          hostConfig: {
                            type: 'object',
                            properties: {
                              networkMode: { type: 'string' },
                            },
                            additionalProperties: true,
                          },
                          networkSettings: {
                            type: 'object',
                            properties: {
                              networks: {
                                type: 'object',
                                additionalProperties: {
                                  type: 'object',
                                  properties: {
                                    networkID: { type: 'string' },
                                    endpointID: { type: 'string' },
                                    gateway: { type: 'string' },
                                    iPAddress: { type: 'string' },
                                    iPPrefixLen: { type: 'number' },
                                    macAddress: { type: 'string' },
                                  },
                                },
                              },
                            },
                          },
                          mounts: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                type: { type: 'string' },
                                source: { type: 'string' },
                                destination: { type: 'string' },
                                mode: { type: 'string' },
                                rw: { type: 'boolean' },
                                propagation: { type: 'string' },
                                name: { type: 'string' },
                                driver: { type: 'string' },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        500: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
            details: { type: 'string' },
          },
        },
      },
    },
    handler: listContainers,
  });

  fastify.post('/containers', {
    schema: {
      tags: ['containers'],
      summary: 'Execute action on containers',
      description: `Performs the specified action (${containerActions.map(possibleAction => `${possibleAction}`)}) on one or more containers`,
      body: {
        type: 'object',
        required: ['action', 'ids'],
        properties: {
          action: {
            type: 'string',
            enum: containerActions,
            description: 'The action to perform on the containers',
          },
          ids: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            description: 'Array of container NAMEs to perform the action on',
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: {
              type: 'boolean',
              const: true,
            },
            data: {
              type: 'object',
              properties: {
                pruneResult: {
                  type: 'string',
                },
                containers: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: {
                        type: 'string',
                        description: 'Container NAME',
                      },
                      status: {
                        type: 'string',
                        enum: ['OK', 'ERROR'],
                        description: 'Action execution status',
                      },
                      message: {
                        type: 'string',
                        description: 'Result message or error description',
                      },
                    },
                  },
                },
              },
            },
          },
        },
        500: {
          type: 'object',
          properties: {
            success: {
              type: 'boolean',
              const: false,
            },
            error: {
              type: 'string',
              description: 'Error message',
            },
            details: {
              type: 'string',
              description: 'Additional error details',
            },
          },
          additionalProperties: false,
        },
      },
    },
    handler: doContainersAction,
  });
};

export default containerRoutes;
