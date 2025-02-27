import { AddAgentHandler } from './addAgent.model';
import { ComposeFile } from '../../../models/composeFile.model';

import writeYmlFile from '../../../helpers/writeYmlFile/writeYmlFile';

const handler: AddAgentHandler = async (req, reply) => {
  try {
    const composeFile = (req.body.agents || []).reduce<ComposeFile>(
      (acc, { imageName, type, nickname, tag, environment }) => {
        if (!type) {
          return acc;
        }

        const containerName = `${imageName}-${type}-agent`;

        return {
          ...acc,
          services: {
            ...acc.services,
            [containerName]: {
              ...acc?.services?.[containerName],
              image: `molo17/${imageName}:${tag || 'latest'}`,
              container_name: nickname || containerName,
              restart: 'unless-stopped',
              environment: Object.entries({ type, ...environment }).map(
                ([key, value]) => `${key}=${value}`,
              ),
            },
          },
        };
      },
      {},
    );

    await writeYmlFile(composeFile, 'compose.agents.yml');

    reply.statusCode = 200;
    reply.send({ success: true, data: composeFile });
  } catch (error) {
    req.log.error(`Error: ${JSON.stringify(error)}`);
    process.exit(1);
  }
};

export default handler;
