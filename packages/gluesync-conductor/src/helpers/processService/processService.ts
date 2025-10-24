import { readComposeFile } from '../composeFile/readComposeFile/readComposeFile';
import writeComposeFile from '../composeFile/writeComposeFile/writeComposeFile';
import extractImageInfo from '../extractImageInfo/extractImageInfo';
import {
  ServiceResultItem,
  CreateServiceError,
  ProcessServices,
} from './processService.model';

const createServiceError: CreateServiceError = (message, status, serviceId) => {
  const error = new Error(message);
  return {
    message: error.message,
    name: error.name,
    stack: error.stack,
    status,
    serviceId,
    error: message,
  };
};

const processServices: ProcessServices = async (
  composeJson,
  services,
  validate,
  createService,
) => {
  const coreHub = (
    process.env.DKR_COMPOSE_FILE_SOURCE !== process.env.DKR_COMPOSE_FILE
      ? await readComposeFile({
          filename: process.env.DKR_COMPOSE_FILE_SOURCE,
          raw: true,
        })
      : composeJson
  ).services?.[process.env.CORE_HUB_NAME || 'gluesync-core-hub'];

  const coreHubVersionTag = extractImageInfo(coreHub?.image || '').tag;

  if (!coreHubVersionTag) {
    throw new Error('Core-hub Version Tag not found or empty');
  }

  const servicePromises = services.map(
    service =>
      new Promise<ServiceResultItem>((resolve, reject) => {
        const { imageName, type, agentType, id } = service;

        const serviceId =
          service.serviceId ??
          `gs-${imageName}-${type}${agentType ? `-${agentType}` : ''}-${id}`;

        const validationResult = validate(
          service,
          serviceId,
          composeJson.services,
        );

        if (!validationResult.success) {
          reject(
            createServiceError(
              validationResult.errorMessage,
              validationResult.statusCode,
              serviceId,
            ),
          );
        } else {
          const rawService = createService({
            ...service,
            tag: coreHubVersionTag,
          });

          resolve({
            success: true,
            serviceId,
            service: rawService,
          });
        }
      }),
  );

  const results = await Promise.allSettled(servicePromises);

  const updatedServices = results.reduce(
    (acc, result) =>
      result.status === 'fulfilled' && result.value.success
        ? { ...acc, [result.value.serviceId]: result.value.service }
        : acc,
    {},
  );

  const updatedComposeJson = {
    ...composeJson,
    services: {
      ...composeJson.services,
      ...updatedServices,
    },
  };

  await writeComposeFile(updatedComposeJson);

  return {
    results: results.map(r =>
      r.status === 'fulfilled'
        ? r.value
        : {
            success: false,
            error:
              (r.reason && (r.reason.error || r.reason.message)) ||
              'Unknown error',
            serviceId: r.reason?.serviceId,
          },
    ),
    updatedComposeJson,
  };
};

export default processServices;
