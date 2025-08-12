import listContainers from '../functions/container/listContainers/listContainers';
import getContainer from '../functions/container/getContainer/getContainer';
import getContainerVersion from '../functions/container/getContainerVersion/getContainerVersion';
import updateContainer from '../functions/container/updateContainer/updateContainer';
import pullContainer from '../functions/container/pullContainer/pullContainer';
import restartContainer from '../functions/container/restartContainer/restartContainer';
import removeAgent from '../functions/agent/removeAgent/removeAgent';
import startAgents from '../functions/agent/startAgents/startAgents';
import stopAgents from '../functions/agent/stopAgents/stopAgents';
import { FastifyInstance, FastifyPluginOptions } from 'fastify';

export default async function containerRoutes(
  fastify: FastifyInstance,
  options: FastifyPluginOptions,
) {
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
      description: 'List all containers',
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              additionalProperties: true,
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
                    additionalProperties: true,
                    properties: {
                      id: { type: 'string' },
                      name: { type: 'string' },
                      image: { type: 'string' },
                      tag: { type: 'string' },
                      versionTag: { type: 'string' },
                      persisted: { type: 'boolean' },
                      created: { type: 'string' },
                      running: { type: 'boolean' },
                      status: { type: 'string' },
                      exitCode: { type: 'number' },
                      startedAt: { type: 'string' },
                      finishedAt: { type: 'string' },
                      cmd: { type: 'array', items: { type: 'string' } },
                      env: { type: 'array', items: { type: 'string' } },
                      labels: { type: 'object', additionalProperties: true },
                      networkMode: { type: 'string' },
                      privileged: { type: 'boolean' },
                      ports: {
                        type: 'array',
                        items: { type: 'object', additionalProperties: true },
                      },
                      mounts: {
                        type: 'array',
                        items: { type: 'object', additionalProperties: true },
                      },
                      hostConfig: {
                        type: 'object',
                        additionalProperties: true,
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

  fastify.post('/containers/:id/start', {
    schema: {
      description: 'Start a container',
      tags: ['containers'],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Container ID to start' },
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
    handler: startAgents,
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
}
