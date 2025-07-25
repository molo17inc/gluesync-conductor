import { ListContainersHandler } from './listContainers.model';

import containerInfoMapper from '../../../helpers/dockerode/containerInfoMapper/containerInfoMapper';
import readComposeFile from '../../../helpers/composeFile/readComposeFile/readComposeFile';
import getSystemInfo from '../../../helpers/dockerode/getSystemInfo/getSystemInfo';
import { LabelPrefix } from '../../../models/composeFile.model';
import { ContainerInfo } from 'dockerode';

const handler: ListContainersHandler = async (req, reply) => {
  try {
    // Get Docker system information (CPU count and total memory)
    // Read the compose file to check which containers are persisted
    // Use all: true to show all containers (not just running ones)
    const [systemInfo, composeJson = {}, containerList] = await Promise.all([
      getSystemInfo(req.server.docker, req.log),
      readComposeFile(),
      req.server.docker.listContainers({ all: true }),
    ]);

    const dockerComposeServicesNames = Object.keys(composeJson.services || {});

    req.log.debug(
      `dockerComposeServicesNames: ${JSON.stringify(dockerComposeServicesNames)}`,
    );

    req.log.debug(`containerList: ${JSON.stringify(containerList)}`);

    const containerListMap = containerList.reduce<
      Record<string, ContainerInfo>
    >((acc, container) => {
      const serviceName = container.Labels[`${LabelPrefix.COMPOSE}.service`];

      return {
        ...acc,
        [serviceName]: container,
      };
    }, {});

    const allServicesNames = [
      ...new Set([
        ...dockerComposeServicesNames,
        ...containerList.reduce<ReadonlyArray<string>>(
          (acc, { Labels }) => [
            ...acc,
            Labels[`${LabelPrefix.COMPOSE}.service`],
          ],
          [],
        ),
      ]),
    ];

    const containers = allServicesNames.map(id => {
      const info = containerInfoMapper(containerListMap[id]);
      const service = composeJson.services?.[id];

      return {
        id,
        service,
        info,
      };
    });

    reply.statusCode = 200;
    reply.send({
      success: true,
      data: {
        containers,
        systemInfo,
      },
    });
  } catch (error) {
    req.log.error(
      `Error listing containers: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
    );

    try {
      await req.server.docker.ping();
      req.log.debug('Docker daemon is responding to ping');
    } catch (pingError) {
      req.log.error(
        `Docker daemon ping failed: ${pingError instanceof Error ? pingError.message : String(pingError)}`,
      );
    }

    reply.statusCode = 500;
    reply.send({
      success: false,
      error: 'Failed to list containers',
      details: error instanceof Error ? error.message : String(error),
    });
  }
};

export default handler;
