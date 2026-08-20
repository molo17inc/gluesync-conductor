import { RouteHandlerMethod } from 'fastify';

import {
  readEnvFile,
  isLegacyUpdateEnabled,
} from '../../../helpers/envFile/envFile';
import { getLogger } from '../../../utils/logger';
import { LegacyUpdateEnvErrorResponse } from './legacyUpdate.model';

const getLegacyUpdate: RouteHandlerMethod = async (_req, reply) => {
  try {
    const lines = await readEnvFile();
    const enabled = isLegacyUpdateEnabled(lines);

    reply.code(200).send({ success: true, data: { enabled } });
  } catch (error) {
    const logger = getLogger();
    logger.error({ error }, '[legacy-update] Failed to read .env file');

    reply.code(500).send({
      success: false,
      error: 'Failed to read .env file',
    } as LegacyUpdateEnvErrorResponse);
  }
};

export default getLegacyUpdate;
