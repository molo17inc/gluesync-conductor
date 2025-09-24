import { castObject } from '../../../helpers/composeFile/extractKeyValue/extractKeyValue';
import { readComposeFile } from '../../../helpers/composeFile/readComposeFile/readComposeFile';
import { ComposeService, LabelPrefix } from '../../../models/composeFile.model';
import { GetAgentsHandler, GetAgentsParams } from './getAgents.model';

const handler: GetAgentsHandler = async (req, reply) => {
  try {
    const { id } = castObject<GetAgentsParams>(req.params);
    const composeJson = await readComposeFile({ raw: false });

    if (!!id?.trim()) {
      const service = composeJson.services?.[id];
      if (!service) {
        return reply.code(404).send({
          success: false,
          error: `Agent ${id} not found in docker file`,
        });
      }
      return reply.send({
        success: true,
        data: { [id]: service },
      });
    }

    const services: Record<string, ComposeService> = Object.entries(
      composeJson.services ?? {},
    )
      .filter(
        ([, service]) =>
          service.labels?.[`${LabelPrefix.CONDUCTOR}.type`] === 'agent',
      )
      .reduce(
        (acc, [name, service]) => ({
          ...acc,
          [name]: service,
        }),
        {} as Record<string, ComposeService>,
      );

    return reply.send({
      success: true,
      data: services || {},
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
