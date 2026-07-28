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
import waitForDockerDaemon from '../../../helpers/dockerode/waitForDockerDaemon/waitForDockerDaemon';
import isTransientDockerConnError from '../../../helpers/dockerode/isTransientDockerConnError/isTransientDockerConnError';
import { getLogger } from '../../../utils/logger';
import {
  type AuthenticatedRequest,
  canModifyConfiguration,
} from '../../../security';
import { redactService } from '../../../helpers/redactedServices/redactedServices';

const handler: ListContainersHandler = async (req, reply) => {
  try {
    const { type } = castObject<ListContainersParams>(req.query);
    const logger = getLogger();

    const composeJson = (await readComposeFile()) ?? {};
    const dockerComposeServicesNames = Object.keys(composeJson.services || {});

    await waitForDockerDaemon(req.server.docker, logger, {
      totalTimeoutMs: 5000,
      perAttemptTimeoutMs: 800,
    });

    const safeFetch = async () =>
      Promise.all([
        getSystemInfo(req.server.docker, logger),
        req.server.docker.listContainers({ all: true }),
      ]);

    const [systemInfo, containerList] = await (async () => {
      try {
        return await safeFetch();
      } catch (error) {
        if (isTransientDockerConnError(error)) {
          req.log.warn('[list-containers] docker pipe busy — retrying');

          await waitForDockerDaemon(req.server.docker, logger, {
            totalTimeoutMs: 4000,
            perAttemptTimeoutMs: 800,
          });

          return safeFetch();
        }
        throw error;
      }
    })();

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
          .filter(Boolean),
      ]),
    ];

    const containers: ListContainersSuccessResponse['containers'] =
      allServicesNames.map(id => {
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

    const user = (req as AuthenticatedRequest).currentUser;
    const canViewSensitive = Boolean(user && canModifyConfiguration(user.role));

    const redactedContainers = canViewSensitive
      ? filteredContainers
      : filteredContainers.map(({ service, ...container }) => ({
          ...container,
          service: redactService(
            service as Record<string, unknown>,
          ) as NonNullable<typeof service>,
        }));

    reply.code(200).send({
      success: true,
      data: {
        containers: redactedContainers,
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
