import { FastifyInstance } from 'fastify';
import collectLogs from '../functions/support/collectLogs/collectLogs';
import collectLogsStreaming from '../functions/support/collectLogsStreaming/collectLogsStreaming';

const supportRoutes = async (fastify: Readonly<FastifyInstance>) => {
  fastify.post('/collectLogs', {
    schema: {
      tags: ['support'],
      summary: 'Send logs with ticket and email',
      description:
        'Runs the support script that uploads the zipped logs and returns its output',
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          raw: { type: 'boolean' },
        },
      },
      body: {
        type: 'object',
        required: ['ticketId', 'email'],
        additionalProperties: false,
        properties: {
          ticketId: {
            type: 'string',
            description: 'Ticket ID in the issue tracker',
          },
          email: {
            type: 'string',
            description: 'User email sending the logs',
          },
        },
      },
      response: {
        200: {
          type: 'object',
          required: ['success', 'output'],
          additionalProperties: false,
          properties: {
            success: { type: 'boolean', const: true },
            output: { type: 'string' },
          },
        },
        400: {
          type: 'object',
          required: ['success', 'error'],
          additionalProperties: false,
          properties: {
            success: { type: 'boolean', const: false },
            error: { type: 'string' },
            details: { type: 'string' },
          },
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
    handler: collectLogs,
  });
  fastify.post('/collectLogsStreaming', {
    schema: {
      tags: ['support'],
      summary: 'Send logs with ticket and email logging in the console',
      description:
        'Runs the support script that uploads the zipped logs and returns its output',
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          raw: { type: 'boolean' },
        },
      },
      body: {
        type: 'object',
        required: ['ticketId', 'email'],
        additionalProperties: false,
        properties: {
          ticketId: {
            type: 'string',
            description: 'Ticket ID in the issue tracker',
          },
          email: {
            type: 'string',
            description: 'User email sending the logs',
          },
        },
      },
      response: {
        200: {
          type: 'object',
          required: ['success', 'output'],
          additionalProperties: false,
          properties: {
            success: { type: 'boolean', const: true },
            output: { type: 'string' },
          },
        },
        400: {
          type: 'object',
          required: ['success', 'error'],
          additionalProperties: false,
          properties: {
            success: { type: 'boolean', const: false },
            error: { type: 'string' },
            details: { type: 'string' },
          },
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
    handler: collectLogsStreaming,
  });
};

export default supportRoutes;
