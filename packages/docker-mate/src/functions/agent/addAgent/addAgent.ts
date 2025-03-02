import { AddAgentHandler } from './addAgent.model';
import { ComposeFile } from '../../../models/composeFile.model';

import writeYmlFile from '../../../helpers/writeYmlFile/writeYmlFile';
import readYmlFile from '../../../helpers/readYmlFile/readYmlFile';
import mergeComposeFiles from '../../../helpers/mergeComposeFiles/mergeComposeFiles';

const filename = 'compose.agents.yml';

const handler: AddAgentHandler = async (req, reply) => {
  try {
    const parsedJson = await readYmlFile<ComposeFile>(filename);

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

    const newComposeFile = mergeComposeFiles([parsedJson, composeFile]);

    await writeYmlFile(newComposeFile, 'compose.agents.yml');

    reply.statusCode = 200;
    reply.send({ success: true, data: newComposeFile });
  } catch (error) {
    req.log.error(`Error: ${JSON.stringify(error)}`);
    process.exit(1);
  }
};

export default handler;
