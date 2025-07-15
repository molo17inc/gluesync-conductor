import { AddAgentHandler } from './addAgent.model';
import { ComposeFile } from '../../../models/composeFile.model';

import writeComposeFile from '../../../helpers/writeComposeFile/writeComposeFile';
import readComposeFile from '../../../helpers/readComposeFile/readComposeFile';
import mergeComposeFiles from '../../../helpers/mergeComposeFiles/mergeComposeFiles';
import { createComposeService } from '../../../utils/createComposeService';

const handler: AddAgentHandler = async (req, reply) => {
  try {
    const parsedJson = (await readComposeFile()) || {};

    const composeFile = (req.body.agents || []).reduce<ComposeFile>(
      (acc, agent) => {
        if (!agent.type) {
          return acc;
        }
        const {
          imageName,
          type,
          name,
          tag,
          environment,
          ports = [],
          volumes = [],
        } = agent;

        const containerName = `${imageName}-${type}-agent`;
        const agentLabels = [
          `com.molo17.conductor.unique_id=${name || containerName}`,
          `com.molo17.conductor.versiontag=${tag}`,
          'com.molo17.conductor.type=agent',
        ];
        const service = createComposeService({
          imageName,
          type,
          name,
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

    req.log.debug(`Compose file to be merged: ${JSON.stringify(composeFile)}`);

    const newComposeFile = mergeComposeFiles([parsedJson, composeFile]);

    req.log.debug(`Merged compose file: ${JSON.stringify(newComposeFile)}`);

    await writeComposeFile(newComposeFile);

    reply.statusCode = 200;
    reply.send({ success: true, data: newComposeFile });
  } catch (error) {
    req.log.error(`Error: ${JSON.stringify(error)}`);
    process.exit(1);
  }
};

export default handler;
