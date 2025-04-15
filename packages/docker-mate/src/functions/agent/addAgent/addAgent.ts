import { AddAgentHandler } from './addAgent.model';
import { ComposeFile } from '../../../models/composeFile.model';

import writeYmlFile from '../../../helpers/writeYmlFile/writeYmlFile';
import readYmlFile from '../../../helpers/readYmlFile/readYmlFile';
import mergeComposeFiles from '../../../helpers/mergeComposeFiles/mergeComposeFiles';
import { createComposeService } from '../../../utils/createComposeService';

const filename = 'compose.agents.yml';

const handler: AddAgentHandler = async (req, reply) => {
  try {
    const parsedJson = await readYmlFile<ComposeFile>(filename)|| {};

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
          ports = [],
          volumes = [],
        } = agent;

        const containerName = `${imageName}-${type}-agent`;
        const agentLabels = [
          `com.molo17.conductor.unique_id=${nickname || containerName}`,
          `com.molo17.conductor.versiontag=${tag || 'latest'}`,
          'com.molo17.conductor.type=agent',
        ];
        const service = createComposeService({
          imageName,
          type,
          nickname,
          tag,
          environment,
          ports,
          volumes,
          labels: agentLabels,
          extraEnv: { GLUESYNC_MODULE_TAG: 'gluesync-conductor' },
        });
        return {
          ...acc,
          services: {
            ...acc.services,
            [containerName]: {
              ...acc?.services?.[containerName],
              ...service,
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
