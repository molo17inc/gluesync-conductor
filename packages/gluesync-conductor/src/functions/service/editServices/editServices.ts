import serviceValidation from '../../../helpers/serviceValidation/serviceValidation';
import cleanResults from '../../../helpers/cleanResults/cleanResults';
import createComposeService from '../../../helpers/composeFile/createComposeService/createComposeService';
import { castObject } from '../../../helpers/composeFile/extractKeyValue/extractKeyValue';
import { readComposeFile } from '../../../helpers/composeFile/readComposeFile/readComposeFile';
import processServices from '../../../helpers/processService/processService';
import { Service } from '../../../helpers/processService/processService.model';
import {
  EditServicesHandler,
  EditServicesQuerystring,
  EditServicesSuccessResponse,
} from './editServices.model';

const handler: EditServicesHandler = async (req, reply) => {
  const { raw } = castObject<EditServicesQuerystring>(req.query) || false;
  const services: ReadonlyArray<Service> = req.body.services ?? [];
  const rawComposeJson = await readComposeFile({ raw: true });

  try {
    const { results } = await processServices(
      rawComposeJson,
      services,
      (serviceToValidate, serviceId, servicesInCompose) =>
        serviceValidation(
          'edit',
          serviceToValidate,
          serviceId,
          servicesInCompose,
        ),
      ({ reservations, limits, ...service }) =>
        createComposeService(service.type, {
          ...service,
          id: service.serviceId
            ? (service.serviceId.split('-').at(-1) ?? '')
            : '',
          resources: { reservations, limits },
        }),
    );

    const response: EditServicesSuccessResponse = {
      success: true,
      results: raw ? results : await cleanResults(results),
    };

    reply.code(200).send(response);
  } catch (error) {
    reply.code(500).send({
      success: false,
      error: `Failed to edit services: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
};

export default handler;
