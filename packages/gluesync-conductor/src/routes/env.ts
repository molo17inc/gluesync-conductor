import { FastifyInstance } from 'fastify';

import getLegacyUpdate from '../functions/env/legacyUpdate/getLegacyUpdate';
import setLegacyUpdate from '../functions/env/legacyUpdate/setLegacyUpdate';
import { requireConfig } from '../security';

const envRoutes = async (fastify: Readonly<FastifyInstance>) => {
  fastify.get('/env/legacy-update', {
    schema: {
      tags: ['env'],
      summary: 'Get legacy update flag',
      description:
        'Returns whether GS_LEGACY_TLS=1 is currently set in the .env file.',
      response: {
        200: {
          type: 'object',
          required: ['success', 'data'],
          additionalProperties: false,
          properties: {
            success: { type: 'boolean', const: true },
            data: {
              type: 'object',
              required: ['enabled'],
              additionalProperties: false,
              properties: {
                enabled: { type: 'boolean' },
              },
            },
          },
        },
        500: {
          type: 'object',
          required: ['success', 'error'],
          additionalProperties: false,
          properties: {
            success: { type: 'boolean', const: false },
            error: { type: 'string' },
            details: { type: 'string', nullable: true },
          },
        },
      },
    },
    preHandler: [requireConfig()],
    handler: getLegacyUpdate,
  });

  fastify.put('/env/legacy-update', {
    schema: {
      tags: ['env'],
      summary: 'Set legacy update flag',
      description: 'Adds or removes GS_LEGACY_TLS=1 from the .env file.',
      body: {
        type: 'object',
        required: ['enabled'],
        additionalProperties: false,
        properties: {
          enabled: { type: 'boolean' },
        },
      },
      response: {
        200: {
          type: 'object',
          required: ['success'],
          additionalProperties: false,
          properties: {
            success: { type: 'boolean', const: true },
          },
        },
        400: {
          type: 'object',
          required: ['success', 'error'],
          additionalProperties: false,
          properties: {
            success: { type: 'boolean', const: false },
            error: { type: 'string' },
            details: { type: 'string', nullable: true },
          },
        },
        500: {
          type: 'object',
          required: ['success', 'error'],
          additionalProperties: false,
          properties: {
            success: { type: 'boolean', const: false },
            error: { type: 'string' },
            details: { type: 'string', nullable: true },
          },
        },
      },
    },
    preHandler: [requireConfig()],
    handler: setLegacyUpdate,
  });
};

export default envRoutes;
