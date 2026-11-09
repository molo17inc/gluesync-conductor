import { inspectDisasterRecovery } from '../../../helpers/disasterRecoverySetup/disasterRecoverySetup';
import buildLocalErrorReply from '../../../diagnosis/buildLocalErrorReply';
import describeFailure from '../../../helpers/describeFailure/describeFailure';
import { getLogger } from '../../../utils/logger';
import type { DisasterRecoveryHandler } from '../disasterRecovery.model';

const READ_FAILED = 'Failed to read the disaster recovery setup';

/** What the guided setup can do on this host, and what is set up. Never returns a secret. */
const getDisasterRecoverySetup: DisasterRecoveryHandler = async (
  request,
  reply,
) => {
  try {
    const { state } = await inspectDisasterRecovery(request.server.docker);

    reply.code(200).send({ success: true, data: state });
  } catch (error) {
    getLogger().error({ error }, `[disaster-recovery] ${READ_FAILED}`);

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

export default getDisasterRecoverySetup;
