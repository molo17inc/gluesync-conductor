import { AddAgentsHandler } from './addAgents.model';
import { ComposeFile } from '../../../models/composeFile.model';

import writeComposeFile from '../../../helpers/composeFile/writeComposeFile/writeComposeFile';
import readComposeFile from '../../../helpers/composeFile/readComposeFile/readComposeFile';
import mergeComposeFiles, {
  mergeServices,
} from '../../../helpers/composeFile/mergeComposeFiles/mergeComposeFiles';
import createComposeService from '../../../helpers/composeFile/createComposeService/createComposeService';

const handler: AddAgentsHandler = async (req, reply) => {
  try {
    const composeJson = (await readComposeFile()) || {};

    const composeFile = (req.body.agents || []).reduce<ComposeFile>(
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
        });

        req.log.debug(`Creating service for agent: ${JSON.stringify(service)}`);

        const services = mergeServices([
          acc.services || {},
          { [service.container_name]: service },
        ]);

        req.log.debug(`New services: ${JSON.stringify(services)}`);

        return {
          ...acc,
          services: mergeServices([
            acc.services || {},
            { [service.container_name]: service },
          ]),
        };
      },
      {},
    );

    req.log.debug(`Compose file to be merged: ${JSON.stringify(composeFile)}`);

    const newComposeFile = mergeComposeFiles([composeJson, composeFile]);

    req.log.debug(`Merged compose file: ${JSON.stringify(newComposeFile)}`);

    await writeComposeFile(newComposeFile);

    reply.statusCode = 200;
    reply.send({ success: true, data: newComposeFile });
  } catch (error) {
    req.log.error(
      `Error adding agent: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
    );
    reply.statusCode = 500;
    reply.send({
      success: false,
      error: `Failed to add agent: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
};

export default handler;
