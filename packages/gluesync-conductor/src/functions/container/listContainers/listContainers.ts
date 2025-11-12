import { ContainerInfo } from 'dockerode';

import { LabelPrefix } from '../../../models/composeFile.model';
import {
  ListContainersHandler,
  ListContainersParams,
  ListContainersSuccessResponse,
} from './listContainers.model';

import containerInfoMapper from '../../../helpers/dockerode/containerInfoMapper/containerInfoMapper';
import { readComposeFile } from '../../../helpers/composeFile/readComposeFile/readComposeFile';
import getSystemInfo from '../../../helpers/dockerode/getSystemInfo/getSystemInfo';
import { castObject } from '../../../helpers/composeFile/extractKeyValue/extractKeyValue';
import parseServiceType from '../../../helpers/composeFile/parseServiceType/parseServiceType';
import {
  ConductorServiceTypes,
  conductorServiceTypes,
} from '../../../models/conductor.model';
import { EXCLUDED_SERVICES } from '../../../helpers/fetchAllServicesInCompose/fetchAllServicesInCompose.model';

const handler: ListContainersHandler = async (req, reply) => {
  try {
    const { type } = castObject<ListContainersParams>(req.query);

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

    const containers: ListContainersSuccessResponse['containers'] =
      allServicesNames
        .filter(id => !!id)
        .filter(id => !EXCLUDED_SERVICES.has(id))
        .map(id => {
          const service = composeJson.services?.[id];
          const info = containerInfoMapper(containerListMap[id]);

          const serviceName =
            service?.labels?.[`${LabelPrefix.COMPOSE}.service`];
          const persisted = info?.uniqueId === serviceName;

          const serviceType =
            parseServiceType(
              service?.labels?.[`${LabelPrefix.CONDUCTOR}.type`],
            ) || parseServiceType(info?.type);

          return {
            id,
            persisted,
            type:
              (persisted ? serviceType : parseServiceType(info?.type)) ||
              'unknown',
            service,
            info,
          };
        });

    const filteredContainers = containers.filter(({ type: currentType }) => {
      if (!type || type === 'all') {
        return true;
      }

      if (type === 'unknown') {
        return !conductorServiceTypes.includes(
          currentType as ConductorServiceTypes,
        );
      }

      return currentType === type;
    });

    reply.code(200);
    reply.send({
      success: true,
      data: {
        containers: filteredContainers,
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

    reply.code(500);
    reply.send({
      success: false,
      error: 'Failed to list containers',
      details: error instanceof Error ? error.message : String(error),
    });
  }
};

export default handler;
