import { AddAgentBody, AddAgentHandler } from './removeAgent.model';
import { ComposeFile } from '../../../models/composeFile.model';

import writeYmlFile from '../../../helpers/writeYmlFile/writeYmlFile';
import readYmlFile from '../../../helpers/readYmlFile/readYmlFile';
import removeKey from '../../../helpers/removeKey/removeKey';

const filename = 'compose.agents.yml';

const handler: AddAgentHandler = async (req, reply) => {
  try {
    const parsedJson = await readYmlFile<ComposeFile>(filename);

    const duplicatedAgent = (req.body.agents || []).reduce<
      AddAgentBody['agents']
    >(
      (acc, { isSource, isTarget, ...agent }) => [
        ...acc,
        ...(isSource ? [{ ...agent, isSource, isTarget: !isSource }] : []),
        ...(isTarget ? [{ ...agent, isTarget, isSource: !isTarget }] : []),
      ],
      [],
    );

    const composeFile = duplicatedAgent.reduce<ComposeFile>(
      (acc, { dockerHubRepoName, isSource, isTarget }) => {
        if (!isSource && !isTarget) {
          return acc;
        }

        const containerName = `${dockerHubRepoName}-${isSource ? 'source' : 'target'}-agent`;

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
