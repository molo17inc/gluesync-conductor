import { castObject } from '../../../helpers/composeFile/extractKeyValue/extractKeyValue';
import { readComposeFile } from '../../../helpers/composeFile/readComposeFile/readComposeFile';
import {
  ComposeService,
  LabelPrefix,
  RawComposeService,
} from '../../../models/composeFile.model';
import { ConductorServiceTypes } from '../../../models/conductor.model';
import {
  GetAgentsHandler,
  GetAgentsParams,
  GetAgentsQuerystring,
} from './getAgents.model';

const handler: GetAgentsHandler = async (req, reply) => {
  try {
    const { raw } = castObject<GetAgentsQuerystring>(req.query) || false;
    const { id } = castObject<GetAgentsParams>(req.params);

    console.log('>>>>>>>> grande come una casa >><<<<<', raw);

    req.log.debug(`Current query: ${raw}, ${typeof raw}`);

    const composeJson = await readComposeFile({ raw });

    if (id?.trim()) {
      const service = composeJson.services?.[id];
      if (!service) {
        return reply.code(404).send({
          success: false,
          error: `Agent ${id} not found in docker file`,
        });
      }
      return reply.send({
        success: true,
        data: raw
          ? { [id]: service as RawComposeService }
          : { [id]: service as ComposeService },
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
      data: services,
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
