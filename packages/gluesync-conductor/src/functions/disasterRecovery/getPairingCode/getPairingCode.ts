import buildLocalErrorReply from '../../../diagnosis/buildLocalErrorReply';
import describeFailure from '../../../helpers/describeFailure/describeFailure';
import {
  MANAGED_BY_KEY,
  MANAGED_BY_VALUE,
} from '../../../helpers/disasterRecoveryCompose/disasterRecoveryCompose';
import {
  encodePairingCode,
  rebuildPairingPayload,
} from '../../../helpers/disasterRecoveryPairing/disasterRecoveryPairing';
import {
  inspectDisasterRecovery,
  readDisasterRecoveryEnv,
} from '../../../helpers/disasterRecoverySetup/disasterRecoverySetup';
import buildModeUnknownReply from '../../../helpers/orchestrator/buildModeUnknownReply/buildModeUnknownReply';
import { getLogger } from '../../../utils/logger';
import type { DisasterRecoveryHandler } from '../disasterRecovery.model';

const LOG = '[disaster-recovery]';
const READ_FAILED = 'Failed to rebuild the pairing code';

/**
 * Shows the pairing code of the first site again, rebuilt from the DR env file the setup wrote.
 * The code holds the shared secret of the pair: it is never logged (nothing here logs the
 * variables or the code, and a refusal names variables, not values) and never cached.
 */
const getPairingCode: DisasterRecoveryHandler = async (request, reply) => {
  const refuse = (error: string, details: string, reason: string): void => {
    getLogger().warn({ reason }, `${LOG} pairing code refused: ${error}`);
    reply.code(409).send({ success: false, error, details });
  };

  try {
    const { state, dockerUnknown } = await inspectDisasterRecovery(
      request.server.docker,
    );

    if (dockerUnknown) {
      reply.code(503).send(buildModeUnknownReply());
      return;
    }

    if (!state.enabled) {
      refuse(
        'Disaster recovery is not enabled on this Core Hub',
        'There is no pairing code to show',
        'not-enabled',
      );
      return;
    }

    const variables = state.managedByConductor
      ? await readDisasterRecoveryEnv()
      : undefined;

    if (variables?.[MANAGED_BY_KEY]?.trim() !== MANAGED_BY_VALUE) {
      refuse(
        'Disaster recovery was not set up by this Conductor',
        'The pairing code can only be rebuilt for a setup made by this Conductor: it is not available for disaster recovery enabled by hand',
        'not-managed',
      );
      return;
    }

    const rebuilt = rebuildPairingPayload(variables);

    if (!rebuilt.ok) {
      refuse(
        'The pairing code cannot be rebuilt on this site',
        rebuilt.missing.length > 0
          ? `The disaster recovery env file lacks ${rebuilt.missing.join(', ')}. Only the first site of a pair set up by this version of the Conductor can show the code`
          : `The disaster recovery env file holds a value that is not valid: ${rebuilt.problems.join('; ')}`,
        'incomplete-env-file',
      );
      return;
    }

    reply
      .header('Cache-Control', 'no-store')
      .code(200)
      .send({
        success: true,
        data: { pairingCode: encodePairingCode(rebuilt.payload) },
      });
  } catch (error) {
    getLogger().error({ error }, `${LOG} ${READ_FAILED}`);

    const local = buildLocalErrorReply(error, READ_FAILED);

    if (local) {
      reply.code(local.statusCode).send(local.body);
      return;
    }

    reply.code(500).send({
      success: false,
      error: READ_FAILED,
      details: describeFailure(error),
    });
  }
};

export default getPairingCode;
