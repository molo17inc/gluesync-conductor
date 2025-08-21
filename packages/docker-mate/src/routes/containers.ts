import { FastifyInstance } from 'fastify';
import listContainers from '../functions/container/listContainers/listContainers';
import getContainer from '../functions/container/getContainer/getContainer';
import getContainerVersion from '../functions/container/getContainerVersion/getContainerVersion';
import updateContainer from '../functions/container/updateContainer/updateContainer';
import pullContainer from '../functions/container/pullContainer/pullContainer';
import restartContainer from '../functions/container/restartContainer/restartContainer';
import removeAgent from '../functions/agent/removeAgent/removeAgent';
import stopAgents from '../functions/agent/stopAgents/stopAgents';
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
                          tag: { type: 'string' },
                          versionTag: { type: 'string' },
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
                    required: ['id', 'persisted'],
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

  fastify.get('/containers/:id', {
    schema: {
      description: 'Get a container configuration',
      tags: ['containers'],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Container ID' },
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
                imageName: { type: 'string' },
                type: { type: 'string', enum: ['target', 'source'] },
                nickname: { type: 'string' },
                tag: { type: 'string' },
                versionTag: { type: 'string' },
                persisted: { type: 'boolean' },
                environment: { type: 'object', additionalProperties: true },
                ports: { type: 'array', items: { type: 'string' } },
                volumes: { type: 'array', items: { type: 'string' } },
                hostConfig: { type: 'object', additionalProperties: true },
              },
            },
            systemInfo: {
              type: 'object',
              properties: {
                ncpu: { type: 'number' },
                memTotal: { type: 'number' },
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
        500: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
      },
    },
    handler: getContainer,
  });

  fastify.get('/containers/:id/version', {
    schema: {
      tags: ['containers'],
      description: 'Get container version information',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Container ID' },
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
                containerId: { type: 'string' },
                containerName: { type: 'string' },
                currentImage: { type: 'string' },
                currentTag: { type: 'string' },
                latestVersion: { type: 'object', additionalProperties: true },
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
    handler: getContainerVersion,
  });

  fastify.put('/containers/:id', {
    schema: {
      description: 'Update a container configuration',
      tags: ['containers'],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Container ID to update' },
        },
      },
      body: {
        type: 'object',
        properties: {
          imageName: {
            type: 'string',
            description: 'Name of the Docker image',
          },
          type: {
            type: 'string',
            enum: ['target', 'source'],
            description: 'Type of the agent',
          },
          nickname: {
            type: 'string',
            description: 'Optional nickname for the agent',
          },
          tag: { type: 'string', description: 'Optional Docker image tag' },
          environment: {
            type: 'object',
            additionalProperties: true,
            description: 'Optional environment variables',
          },
          ports: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional port mappings',
          },
          volumes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional volume mappings',
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
        500: {
          type: 'object',
          properties: {
            success: { type: 'boolean', default: false },
            error: { type: 'string' },
          },
        },
      },
    },
    handler: updateContainer,
  });

  fastify.delete('/containers/:id', {
    schema: {
      description: 'Remove a container from the compose file',
      tags: ['containers'],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Container ID to remove' },
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
    handler: removeAgent,
  });

  fastify.post('/containers/:id/stop', {
    schema: {
      description: 'Stop a container',
      tags: ['containers'],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Container ID to stop' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              additionalProperties: true,
              type: 'array',
              items: { type: 'string' },
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
    handler: stopAgents,
  });

  fastify.post('/containers/:id/pull', {
    schema: {
      description: 'Pull the latest image for a container',
      tags: ['containers'],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Container ID to pull image for' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              additionalProperties: true,
              type: 'array',
              items: { type: 'string' },
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
        500: {
          type: 'object',
          properties: {
            success: { type: 'boolean', default: false },
            error: { type: 'string' },
          },
        },
      },
    },
    handler: pullContainer,
  });

  fastify.post('/containers/:id/restart', {
    schema: {
      description: 'Restart a container',
      tags: ['containers'],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Container ID to restart' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'array',
              items: { type: 'string' },
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
        500: {
          type: 'object',
          properties: {
            success: { type: 'boolean', default: false },
            error: { type: 'string' },
          },
        },
      },
    },
    handler: restartContainer,
  });
};

export default containerRoutes;
