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
      (
        acc,
        {
          imageName,
          type,
          nickname,
          tag,
          environment,
          ports = [],
          volumes = [],
        },
      ) => {
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
              environment: Object.entries({
                type,
                maxRamPercentage: 90.0,
                LOG_CONFIG_FILE: '/opt/gluesync/data/logback.xml',
                ...environment,
              }).map(([key, value]) => `${key}=${value}`),
              ports,
              volumes: [
                './gs-license.dat:/opt/gluesync/data/gs-license.dat:ro',
                './logback.xml:/opt/gluesync/data/logback.xml:ro',
                './security-config.json:/opt/gluesync/data/security-config.json:ro',
                './gluesync.com.jks:/opt/gluesync/data/gluesync.com.jks:ro',
                './bootstrap-core-hub.json:/opt/gluesync/data/bootstrap-core-hub.json:ro',
                `./${containerName}:/opt/gluesync/data`,
                ...volumes,
              ],
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
