import { FastifyPluginCallback } from 'fastify';

import disableDisasterRecovery from '../functions/disasterRecovery/disableDisasterRecovery/disableDisasterRecovery';
import getDisasterRecoverySetup from '../functions/disasterRecovery/getDisasterRecoverySetup/getDisasterRecoverySetup';
import getPairingCode from '../functions/disasterRecovery/getPairingCode/getPairingCode';
import joinSecondSite from '../functions/disasterRecovery/joinSecondSite/joinSecondSite';
import setupFirstSite from '../functions/disasterRecovery/setupFirstSite/setupFirstSite';
import { requireConfig } from '../security';
import {
  DIAGNOSIS_REPLY_PROPERTY,
  DISK_FULL_REPLY_SCHEMA,
} from '../diagnosis/diagnosisReplySchema';

const errorReply = (description: string) => ({
  description,
  type: 'object',
  required: ['success', 'error'],
  additionalProperties: false,
  properties: {
    success: { type: 'boolean', const: false },
    error: { type: 'string' },
    details: { type: 'string', nullable: true },
    diagnosis: DIAGNOSIS_REPLY_PROPERTY,
  },
});

const successReply = (
  description: string,
  data: Readonly<Record<string, unknown>>,
) => ({
  description,
  type: 'object',
  required: ['success', 'data'],
  additionalProperties: false,
  properties: {
    success: { type: 'boolean', const: true },
    data,
  },
});

const restartingProperty = {
  type: 'array',
  description:
    'The services recreated after this answer is sent, Core Hub first. The UI loses its connection while they restart.',
  items: { type: 'string' },
};

const siteSchema = {
  type: 'object',
  required: ['nodeId', 'url'],
  additionalProperties: false,
  properties: {
    nodeId: {
      type: 'string',
      description:
        'Id of the site: 1 to 32 characters, lower-case letters, digits and "-", starting with a letter or digit',
    },
    url: {
      type: 'string',
      description:
        'Core Hub base URL of the site, http:// or https:// host:port with no path. The control port and the replication sink are on the same host.',
    },
  },
};

const REFUSED_STATES = {
  400: errorReply('The request is not valid. `details` lists every problem.'),
  403: errorReply('The role of the caller cannot modify the configuration.'),
  409: errorReply(
    'Disaster recovery is already enabled, cannot be set up on this installation, or another container action is running.',
  ),
  503: errorReply(
    'Docker is not answering, so compose cannot be told from swarm yet.',
  ),
  507: DISK_FULL_REPLY_SCHEMA,
  500: errorReply('A file could not be written, or the services failed.'),
};

const disasterRecoveryRoutes: FastifyPluginCallback = (
  fastify,
  _opts,
  done,
) => {
  fastify.get('/disaster-recovery/setup', {
    schema: {
      tags: ['disaster-recovery'],
      summary: 'Get the disaster recovery setup',
      description:
        'Whether the guided disaster recovery setup is available on this host, and what is set up. Read from the compose file alone, so it answers on a standby site too. Never returns a secret.',
      response: {
        200: successReply('The state of disaster recovery on this host', {
          type: 'object',
          required: [
            'supported',
            'reason',
            'enabled',
            'managedByConductor',
            'nodeId',
            'peerUrl',
            'failoverMode',
            'witnessUrl',
            'bootstrapActive',
          ],
          additionalProperties: false,
          properties: {
            supported: {
              type: 'boolean',
              description:
                'False on Docker Swarm, when the Core Hub or Chronos service or the data directory of Chronos cannot be found, or when GS_DR_* variables are set by hand in the Core Hub environment',
            },
            reason: { type: 'string', nullable: true },
            enabled: { type: 'boolean' },
            managedByConductor: {
              type: 'boolean',
              description:
                'True when the variables were written by this setup; disaster recovery enabled by hand is enabled but not managed',
            },
            nodeId: { type: 'string', nullable: true },
            peerUrl: { type: 'string', nullable: true },
            failoverMode: {
              type: 'string',
              enum: ['manual', 'witness'],
              nullable: true,
            },
            witnessUrl: { type: 'string', nullable: true },
            bootstrapActive: { type: 'boolean' },
          },
        }),
        403: REFUSED_STATES[403],
        500: errorReply('The compose file could not be read.'),
      },
    },
    preHandler: [requireConfig()],
    handler: getDisasterRecoverySetup,
  });

  fastify.post('/disaster-recovery/setup/first', {
    schema: {
      tags: ['disaster-recovery'],
      summary: 'Set up the first site of a disaster recovery pair',
      description:
        'Writes the GS_DR_* variables (in `gluesync-dr.env`, read by Core Hub only) and the compose changes a DR site needs, answers 202 with the pairing code for the second site, then recreates Chronos and Core Hub. This site keeps its data and starts active. The pairing code contains the shared secret of the pair, and the operator token is shown only here: keep both private.',
      body: {
        type: 'object',
        required: ['thisSite', 'peerSite', 'failoverMode'],
        additionalProperties: false,
        properties: {
          thisSite: siteSchema,
          peerSite: siteSchema,
          failoverMode: { type: 'string', enum: ['manual', 'witness'] },
          witnessUrl: {
            type: 'string',
            description: 'Required with failoverMode "witness"',
          },
          leaseTtlSeconds: {
            type: 'integer',
            description:
              'Lease time to live with a witness, 20 to 600 seconds, default 30',
          },
        },
      },
      response: {
        202: successReply('Accepted: the services are recreated next', {
          type: 'object',
          required: ['pairingCode', 'operatorToken', 'restarting'],
          additionalProperties: false,
          properties: {
            pairingCode: {
              type: 'string',
              description:
                'GSDR1.<base64url of the JSON>, to enter on the second site. Contains the shared secret.',
            },
            operatorToken: {
              type: 'string',
              description: 'Operator token of the control port of this site',
            },
            restarting: restartingProperty,
          },
        }),
        ...REFUSED_STATES,
      },
    },
    preHandler: [requireConfig()],
    handler: setupFirstSite,
  });

  fastify.post('/disaster-recovery/setup/pairing-code', {
    schema: {
      tags: ['disaster-recovery'],
      summary: 'Show the pairing code of the first site again',
      description:
        'Rebuilds the pairing code from `gluesync-dr.env` of this site, with the content `setup/first` returned: this site is the first, the peer is the joiner. For when the code was lost, for example because the UI session ended when Core Hub restarted. It is a POST so that it is never cached or logged as a URL, and the answer is not cached. The code contains the shared secret of the pair: keep it private. Only the first site of a pair set up by this Conductor can answer: any other host is answered with 409.',
      response: {
        200: successReply('The pairing code of this site', {
          type: 'object',
          required: ['pairingCode'],
          additionalProperties: false,
          properties: {
            pairingCode: {
              type: 'string',
              description:
                'GSDR1.<base64url of the JSON>, to enter on the second site. Contains the shared secret.',
            },
          },
        }),
        403: REFUSED_STATES[403],
        409: errorReply(
          'Disaster recovery is not enabled on this host, was not set up by this Conductor, or this is not the first site of a pair set up by this version (the env file lacks what the code needs). `details` says which.',
        ),
        503: REFUSED_STATES[503],
        500: errorReply('The env file or the compose file could not be read.'),
      },
    },
    preHandler: [requireConfig()],
    handler: getPairingCode,
  });

  fastify.post('/disaster-recovery/setup/join', {
    schema: {
      tags: ['disaster-recovery'],
      summary: 'Set up the second site of a disaster recovery pair',
      description:
        'Decodes the pairing code of the first site, writes this site as the joiner, answers 202, then recreates Chronos and Core Hub. This site becomes the standby: it moves its own databases aside and follows the first one.',
      body: {
        type: 'object',
        required: ['pairingCode', 'confirmDataMovedAside'],
        additionalProperties: false,
        properties: {
          pairingCode: { type: 'string' },
          confirmDataMovedAside: {
            type: 'boolean',
            const: true,
            description:
              'Must be true: the databases of this site are moved aside',
          },
        },
      },
      response: {
        202: successReply('Accepted: the services are recreated next', {
          type: 'object',
          required: ['operatorToken', 'nodeId', 'peerUrl', 'restarting'],
          additionalProperties: false,
          properties: {
            operatorToken: {
              type: 'string',
              description: 'Operator token of the control port of this site',
            },
            nodeId: { type: 'string' },
            peerUrl: { type: 'string' },
            restarting: restartingProperty,
          },
        }),
        ...REFUSED_STATES,
      },
    },
    preHandler: [requireConfig()],
    handler: joinSecondSite,
  });

  fastify.post('/disaster-recovery/disable', {
    schema: {
      tags: ['disaster-recovery'],
      summary: 'Disable the disaster recovery set up by this Conductor',
      description:
        'Removes every GS_DR_* variable, the published ports, the Chronos mount and the Chronos control URL that the setup added (anything else stays), answers 202, then recreates Chronos and Core Hub. Only a setup made by this Conductor is undone: disaster recovery enabled by hand is answered with 409.',
      body: {
        type: 'object',
        required: ['confirm'],
        additionalProperties: false,
        properties: {
          confirm: { type: 'boolean', const: true },
        },
      },
      response: {
        202: successReply('Accepted: the services are recreated next', {
          type: 'object',
          required: ['restarting'],
          additionalProperties: false,
          properties: { restarting: restartingProperty },
        }),
        ...REFUSED_STATES,
      },
    },
    preHandler: [requireConfig()],
    handler: disableDisasterRecovery,
  });

  done();
};

export default disasterRecoveryRoutes;
