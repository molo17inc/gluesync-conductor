import { FastifyInstance } from 'fastify';
import collectLogs from '../functions/utility/collectLogs/collectLogs';
import { requireManage } from '../security';
import {
  DIAGNOSIS_REPLY_PROPERTY,
  DISK_FULL_REPLY_SCHEMA,
} from '../diagnosis/diagnosisReplySchema';

const utilityRoutes = async (fastify: Readonly<FastifyInstance>) => {
  fastify.post('/collect-logs', {
    schema: {
      tags: ['utility'],
      summary: 'Send logs with ticket and email logging in the console',
      description:
        'Runs the utility script that uploads the zipped logs and returns its output',
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          raw: { type: 'boolean' },
        },
      },
      body: {
        type: 'object',
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
          localOnly: {
            type: 'boolean',
            description:
              'If true, collects and archives logs locally without credential validation or upload',
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
            archivePath: { type: 'string' },
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
        507: DISK_FULL_REPLY_SCHEMA,
        500: {
          type: 'object',
          required: ['success', 'error'],
          additionalProperties: false,
          properties: {
            success: { type: 'boolean', const: false },
            error: { type: 'string' },
            details: { type: 'string' },
            diagnosis: DIAGNOSIS_REPLY_PROPERTY,
          },
        },
      },
    },
    preHandler: [requireManage()],
    handler: collectLogs,
  });
};

export default utilityRoutes;
