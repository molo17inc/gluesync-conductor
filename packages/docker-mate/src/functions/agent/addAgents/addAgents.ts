import { AddAgentsHandler } from './addAgents.model';
import { RawComposeFile } from '../../../models/composeFile.model';

import writeComposeFile from '../../../helpers/composeFile/writeComposeFile/writeComposeFile';
import { readComposeFile } from '../../../helpers/composeFile/readComposeFile/readComposeFile';
import mergeComposeFiles, {
  mergeServices,
} from '../../../helpers/composeFile/mergeComposeFiles/mergeComposeFiles';
import createComposeService from '../../../helpers/composeFile/createComposeService/createComposeService';

const handler: AddAgentsHandler = async (req, reply) => {
  try {
    const composeJson = await readComposeFile({ raw: true });

    const composeFile = (req.body.agents || []).reduce<RawComposeFile>(
      (acc, agent) => {
        if (!agent.type) {
          return acc;
        }

        const {
          imageName,
          type,
          nickname,
          tag,
          environment,
          labels,
          ports = [],
          volumes = [],
          limits,
          reservations,
        } = agent;

        const service = createComposeService('agent', {
          imageName,
          type,
          nickname,
          tag,
          environment,
          ports,
          volumes,
          labels,
          resources: {
            limits,
            reservations,
          },
        });

        req.log.debug(`Creating service for agent: ${JSON.stringify(service)}`);

        const services = mergeServices([
          acc.services || {},
          { [service.container_name]: service },
        ]);

        req.log.debug(`New services: ${JSON.stringify(services)}`);

        return {
          ...acc,
          services,
        };
      },
      {},
    );

    req.log.debug(`Compose file to be merged: ${JSON.stringify(composeFile)}`);

    const newComposeFile = mergeComposeFiles([composeJson, composeFile]);

    req.log.debug(`Merged compose file: ${JSON.stringify(newComposeFile)}`);

    await writeComposeFile(newComposeFile);

    reply.code(200);
    reply.send({ success: true, data: newComposeFile });
  } catch (error) {
    req.log.error(
      `Error adding agent: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
    );
    reply.code(500);
    reply.send({
      success: false,
      error: `Failed to add agent: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
};

export default handler;
