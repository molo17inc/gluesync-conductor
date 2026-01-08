import createComposeService from '../../../helpers/composeFile/createComposeService/createComposeService';
import { readComposeFile } from '../../../helpers/composeFile/readComposeFile/readComposeFile';
import processServices from '../../../helpers/processService/processService';
import { Service } from '../../../helpers/processService/processService.model';
import {
  AddServicesHandler,
  AddServicesQuerystring,
  AddServicesSuccessResponse,
} from './addServices.model';
import createService from '../../../helpers/processService/service.factory';
import serviceValidation from '../../../helpers/serviceValidation/serviceValidation';
import { castObject } from '../../../helpers/composeFile/extractKeyValue/extractKeyValue';
import cleanResults from '../../../helpers/cleanResults/cleanResults';

const handler: AddServicesHandler = async (req, reply) => {
  try {
    const { raw } = castObject<AddServicesQuerystring>(req.query) || false;
    const services: ReadonlyArray<Service> = req.body.services ?? [];
    const servicesWithIds = services.map(createService);

    const rawComposeJson = await readComposeFile({ raw: true });

    const { results } = await processServices(
      rawComposeJson,
      servicesWithIds,
      (serviceToValidate, serviceId, servicesInCompose) =>
        serviceValidation(
          'add',
          serviceToValidate,
          serviceId,
          servicesInCompose,
        ),
      ({ reservations, limits, ...service }) =>
        createComposeService(service.type, {
          ...service,
          id: service.id,
          resources: { reservations, limits },
        }),
    );

    const response: AddServicesSuccessResponse = {
      success: true,
      results: raw ? results : await cleanResults(results),
    };

    reply.code(200).send(response);
  } catch (error) {
    reply.code(500).send({
      success: false,
      error: `Failed to add services: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
};

export default handler;
