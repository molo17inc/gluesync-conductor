import { RemoveAgentHandler } from './removeAgent.model';
import { ComposeFile } from '../../../models/composeFile.model';

import writeYmlFile from '../../../helpers/writeYmlFile/writeYmlFile';
import readYmlFile from '../../../helpers/readYmlFile/readYmlFile';
import removeKey from '../../../helpers/removeKey/removeKey';

const filename = 'compose.agents.yml';

const handler: RemoveAgentHandler = async (req, reply) => {
  try {
    const parsedJson = await readYmlFile<ComposeFile>(filename) || {};

    const composeFile = (req.body.agents || []).reduce<ComposeFile>(
      (acc, { imageName, type }) => {
        if (!type) {
          return acc;
        }

        const containerName = `${imageName}-${type}-agent`;

        return {
          ...acc,
          services: removeKey(parsedJson.services, containerName),
        };
      },
      {},
    );

    await writeYmlFile(composeFile, filename);

    reply.statusCode = 200;
    reply.send({ success: true, data: composeFile });
  } catch (error) {
    req.log.error(`Error: ${JSON.stringify(error)}`);
    process.exit(1);
  }
};

export default handler;
