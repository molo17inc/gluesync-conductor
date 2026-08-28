import { RouteHandlerMethod } from 'fastify';

import {
  readEnvFile,
  writeEnvFile,
  enableLegacyUpdate,
  disableLegacyUpdate,
} from '../../../helpers/envFile/envFile';
import { readComposeFile } from '../../../helpers/composeFile/readComposeFile/readComposeFile';
import writeComposeFile from '../../../helpers/composeFile/writeComposeFile/writeComposeFile';
import buildEnvFileConf from '../../../helpers/buildEnvFileConf/buildEnvFileConf';
import { getLogger } from '../../../utils/logger';
import {
  LegacyUpdateEnvErrorResponse,
  SetLegacyUpdateEnvBody,
} from './legacyUpdate.model';

const setLegacyUpdate: RouteHandlerMethod = async (req, reply) => {
  try {
    const { enabled } = req.body as SetLegacyUpdateEnvBody;

    if (typeof enabled !== 'boolean') {
      reply.code(400).send({
        success: false,
        error: 'Invalid body',
        details: 'enabled must be a boolean',
      } as LegacyUpdateEnvErrorResponse);

      return;
    }

    const lines = await readEnvFile();
    const updated = enabled
      ? enableLegacyUpdate(lines)
      : disableLegacyUpdate(lines);

    await writeEnvFile(updated);

    try {
      const composeFile = await readComposeFile({ raw: true });
      const conductorServiceName =
        process.env.CONDUCTOR_NAME || 'gluesync-conductor';
      const service = composeFile.services?.[conductorServiceName];

      if (service) {
        const updatedService = { ...service, env_file: buildEnvFileConf() };
        const updatedComposeFile = {
          ...composeFile,
          services: {
            ...composeFile.services,
            [conductorServiceName]: updatedService,
          },
        };

        await writeComposeFile(updatedComposeFile);
      }
    } catch (composeError) {
      const logger = getLogger();
      logger.error(
        { error: composeError },
        '[legacy-update] Failed to heal env_file in docker-compose.yml',
      );
    }

    reply.code(200).send({ success: true });
  } catch (error) {
    const logger = getLogger();
    logger.error({ error }, '[legacy-update] Failed to write .env file');

    reply.code(500).send({
      success: false,
      error: 'Failed to write .env file',
    } as LegacyUpdateEnvErrorResponse);
  }
};

export default setLegacyUpdate;
