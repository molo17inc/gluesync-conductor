import runMigrationScript from '../../helpers/runMigrationScript/runMigrationScript';
import { MigrateToTwoHandler } from './migrateToTwo.model';

const migrateToTwoHandler: MigrateToTwoHandler = async (req, reply) => {
  try {
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
  } catch (err) {
    req.log.error({ err }, 'Internal error running migration script');
    return reply.status(500).send({
      success: false,
      error: 'Internal server error',
    });
  }
};

export default migrateToTwoHandler;
