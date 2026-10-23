import buildMigrationRefusedOnSwarmReply from '../../helpers/orchestrator/buildMigrationRefusedOnSwarmReply/buildMigrationRefusedOnSwarmReply';
import buildModeUnknownReply from '../../helpers/orchestrator/buildModeUnknownReply/buildModeUnknownReply';
import { getDecidedOrchestrator } from '../../helpers/orchestrator/getOrchestrator/getOrchestrator';
import runMigrationScript from '../../helpers/runMigrationScript/runMigrationScript';
import { MigrateToTwoHandler } from './migrateToTwo.model';

const migrateToTwoHandler: MigrateToTwoHandler = async (req, reply) => {
  try {
    // The script moves agent data and restarts the stack by hand: neither is
    // right on Swarm, nor guessable while Docker does not answer
    const orchestrator = await getDecidedOrchestrator(req.server.docker);

    if (!orchestrator) {
      return reply.status(503).send(buildModeUnknownReply());
    }

    if (orchestrator.mode === 'swarm') {
      return reply.status(501).send(buildMigrationRefusedOnSwarmReply());
    }

    const result = await runMigrationScript();

    if (result.success) {
      return reply.status(200).send({
        success: true,
        data: result.data,
      });
    }

    return reply.status(500).send({
      success: false,
      error: result.error,
      details: result.details,
    });
  } catch (error) {
    req.log.error({ error }, 'Internal error running migration script');
    return reply.status(500).send({
      success: false,
      error: 'Internal server error',
    });
  }
};

export default migrateToTwoHandler;
