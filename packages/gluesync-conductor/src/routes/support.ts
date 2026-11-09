import { FastifyInstance } from 'fastify';
import collectLogs from '../functions/utility/collectLogs/collectLogs';
import { requireManage } from '../security';
import {
  DIAGNOSIS_REPLY_PROPERTY,
  DISK_FULL_REPLY_SCHEMA,
} from '../diagnosis/diagnosisReplySchema';

// 400, 429 and 502 of /collect-logs: what is wrong with the request, or why the
// support portal refused the upload (`code`, and `maxBytes` with file_too_large)
const UPLOAD_ERROR_REPLY_SCHEMA = {
  type: 'object',
  required: ['success', 'error'],
  additionalProperties: false,
  properties: {
    success: { type: 'boolean', const: false },
    error: { type: 'string' },
    details: { type: 'string' },
    code: {
      type: 'string',
      enum: [
        'validation',
        'voucher_format',
        'voucher_invalid',
        'voucher_expired',
        'file_too_large',
        'rate_limited',
        'portal_unreachable',
      ],
    },
    maxBytes: { type: 'integer' },
  },
} as const;

const utilityRoutes = async (fastify: Readonly<FastifyInstance>) => {
  fastify.post('/collect-logs', {
    schema: {
      tags: ['utility'],
      summary: 'Collect the environment logs and send them to support',
      description:
        'Collects the logs of every container and the diagnostics of this environment into an archive and uploads it to the MOLO17 support portal. With `voucher` (GSV-XXXX-XXXX-XXXX, from the support ticket) the archive goes straight into that ticket through the support portal: the voucher is checked before collecting, nothing falls back to WebDAV, FTP or the legacy script, and the archive is deleted only once the portal verified its size (otherwise `archivePath` says where it stayed). Without a voucher the legacy path runs: `ticketId` (GSSD-1234, 1234 or #1234) and `email`, uploaded via WebDAV, then FTP, then the legacy script. `voucher` cannot be combined with `ticketId` or `email`. With `localOnly` the archive stays on this host and every credential is ignored. The portal address can be overridden with GLUESYNC_SUPPORT_API_URL; requests go through PROXY_HTTPS / PROXY_HTTP when set. Failures of the portal upload carry a `code`: voucher_format, voucher_invalid, voucher_expired, file_too_large (with maxBytes) answer 400; rate_limited answers 429; portal_unreachable answers 502; a body that mixes the voucher with ticketId or email answers 400 validation.',
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
          voucher: {
            type: 'string',
            description:
              'Support voucher of the ticket (GSV-XXXX-XXXX-XXXX): uploads the archive to the support portal. Cannot be combined with ticketId or email',
          },
          ticketId: {
            type: 'string',
            description:
              'Legacy upload only: ticket key in the issue tracker (GSSD-1234, 1234 or #1234)',
          },
          email: {
            type: 'string',
            description:
              'Legacy upload only: email of the user sending the logs',
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
            archivePath: {
              type: 'string',
              description:
                'Where the archive stayed: local-only mode, or an upload the portal could not verify',
            },
            uploadedVia: { type: 'string', enum: ['portal', 'webdav', 'ftp'] },
            ticketKey: { type: 'string' },
            size: {
              type: 'integer',
              description: 'Bytes the support portal holds',
            },
            verified: {
              type: 'boolean',
              description:
                'The portal holds as many bytes as were sent; the local archive is deleted only then',
            },
          },
        },
        400: UPLOAD_ERROR_REPLY_SCHEMA,
        429: UPLOAD_ERROR_REPLY_SCHEMA,
        502: UPLOAD_ERROR_REPLY_SCHEMA,
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
