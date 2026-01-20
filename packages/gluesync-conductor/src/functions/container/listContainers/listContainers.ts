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
import {
  isTransientDockerConnError,
  waitForDockerDaemon,
} from '../../../helpers/dockerode/waitForDockerDaemon/waitForDockerDaemon';

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0;

const handler: ListContainersHandler = async (req, reply) => {
  try {
    const { type } = castObject<ListContainersParams>(req.query);

    // Read compose file first (does not require Docker to be ready)
    const composeJson = (await readComposeFile()) ?? {};
    const dockerComposeServicesNames = Object.keys(composeJson.services || {});

    // Wait for Docker daemon (max 5s) to avoid transient Windows pipe ENOENT
    await waitForDockerDaemon(req.server.docker, req.log, {
      totalTimeoutMs: 5000,
      perAttemptTimeoutMs: 800,
    });

    // Now do Docker-dependent calls
    const [systemInfo, containerList] = await Promise.all([
      getSystemInfo(req.server.docker, req.log),
      req.server.docker.listContainers({ all: true }),
    ]);

    req.log.debug(
      `dockerComposeServicesNames: ${JSON.stringify(dockerComposeServicesNames)}`,
    );
    req.log.debug(`containerList: ${JSON.stringify(containerList)}`);

    const containerListMap = containerList.reduce<
      Record<string, ContainerInfo>
    >((acc, container) => {
      const serviceName = container.Labels?.[`${LabelPrefix.COMPOSE}.service`];

      return serviceName ? { ...acc, [serviceName]: container } : acc;
    }, {});

    const allServicesNames = [
      ...new Set([
        ...dockerComposeServicesNames,
        ...containerList
          .map(c => c.Labels?.[`${LabelPrefix.COMPOSE}.service`])
          .filter(isNonEmptyString),
      ]),
    ];

    const containers: ListContainersSuccessResponse['containers'] =
      allServicesNames
        .filter(id => !EXCLUDED_SERVICES.has(id))
        .map(id => {
          const service = composeJson.services?.[id];
          const info = containerInfoMapper(containerListMap[id]);

          const serviceType =
            parseServiceType(
              service?.labels?.[`${LabelPrefix.CONDUCTOR}.type`],
            ) || parseServiceType(info?.type);

          const persisted = Boolean(service);

          return {
            id,
            persisted,
            agentId: service?.environment?.INITIAL_AGENT_ID
              ? String(service.environment.INITIAL_AGENT_ID)
              : undefined,
            type:
              (persisted ? serviceType : parseServiceType(info?.type)) ||
              'unknown',
            service,
            info,
          };
        });

    const filteredContainers = containers.filter(({ type: currentType }) => {
      if (!type || type === 'all') return true;

      if (type === 'unknown') {
        return !conductorServiceTypes.includes(
          currentType as ConductorServiceTypes,
        );
      }

      return currentType === type;
    });

    reply.code(200).send({
      success: true,
      data: {
        containers: filteredContainers,
        systemInfo,
      },
    });
  } catch (error) {
    req.log.error(
      `Error listing containers: ${
        error instanceof Error ? error.message : JSON.stringify(error)
      }`,
    );

    const transient = isTransientDockerConnError(error);

    reply.code(transient ? 503 : 500).send({
      success: false,
      error: transient
        ? 'Docker daemon not ready yet'
        : 'Failed to list containers',
      details: error instanceof Error ? error.message : String(error),
    });
  }
};

export default handler;
