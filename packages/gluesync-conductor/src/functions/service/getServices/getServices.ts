import { stringify } from 'yaml';
import { castObject } from '../../../helpers/composeFile/extractKeyValue/extractKeyValue';
import { readComposeFile } from '../../../helpers/composeFile/readComposeFile/readComposeFile';
import {
  ComposeService,
  LabelPrefix,
  RawComposeService,
} from '../../../models/composeFile.model';
import { ConductorServiceTypes } from '../../../models/conductor.model';
import {
  GetServicesHandler,
  GetServicesParams,
  GetServicesQuerystring,
} from './getServices.model';

const handler: GetServicesHandler = async (req, reply) => {
  try {
    const { raw, asString } =
      castObject<GetServicesQuerystring>(req.query) || false;
    const { id } = castObject<GetServicesParams>(req.params);

    req.log.debug(
      `Current query: raw:${raw}, ${typeof raw} asString: ${asString}, ${typeof asString}`,
    );

    const composeJson = await readComposeFile({ raw });

    if (id?.trim()) {
      const composeService = composeJson.services?.[id];
      if (!composeService) {
        return reply.code(404).send({
          success: false,
          error: `Service ${id} not found in docker file`,
        });
      }

      const service = raw
        ? { [id]: composeService as RawComposeService }
        : { [id]: composeService as ComposeService };

      return reply.send({
        success: true,
        data: asString ? stringify(service) : service,
      });
    }

    const services = Object.entries(composeJson.services ?? {})
      .filter(([, service]) =>
        raw
          ? Array.isArray(service.labels) &&
            service.labels.includes(`${LabelPrefix.CONDUCTOR}.type=agent`)
          : (service.labels?.[`${LabelPrefix.CONDUCTOR}.type`] as
              | ConductorServiceTypes
              | undefined) === 'agent',
      )
      .reduce(
        (acc, [name, service]) => ({
          ...acc,
          [name]: service,
        }),
        {} as Record<string, RawComposeService | ComposeService>,
      );

    return reply.send({
      success: true,
      data: asString ? stringify(services) : services,
    });
  } catch (error: unknown) {
    req.log.error(
      `Error getting agents: ${error instanceof Error ? error.message : String(error)}`,
    );
    return reply.code(500).send({
      success: false,
      error: `Failed to get agents: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
};

export default handler;
