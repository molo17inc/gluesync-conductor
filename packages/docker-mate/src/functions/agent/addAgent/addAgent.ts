import { AddAgentBody, AddAgentHandler } from './addAgent.model';
import { ComposeFile } from '../../../models/composeFile.model';

import writeYmlFile from '../../../helpers/writeYmlFile/writeYmlFile';

const handler: AddAgentHandler = async (req, reply) => {
  try {
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
          services: {
            ...acc.services,
            [containerName]: {
              ...acc?.services?.[containerName],
              image: `molo17/gluesync-${dockerHubRepoName}:latest`,
              container_name: containerName,
              restart: 'unless-stopped',
              environment: [`type=${isSource ? 'source' : 'target'}`],
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
