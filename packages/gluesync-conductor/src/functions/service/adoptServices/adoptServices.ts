import { FastifyReply, FastifyRequest } from 'fastify';
import { readComposeFile } from '../../../helpers/composeFile/readComposeFile/readComposeFile';
import writeComposeFile from '../../../helpers/composeFile/writeComposeFile/writeComposeFile';
import { LabelPrefix } from '../../../models/composeFile.model';
import agentsJson from '../../../../agents.json';
import parseImage from '../../../helpers/parseImage/parseImage';
import fetchAllServicesInCompose from '../../../helpers/fetchAllServicesInCompose/fetchAllServicesInCompose';

const handler = async (
  req: Readonly<FastifyRequest>,
  reply: Readonly<FastifyReply>,
) => {
  try {
    const composeJson = await readComposeFile({ raw: true });

    // Extract all service IDs without the EXCLUDED_SERVICES
    const allServiceIds: readonly string[] = fetchAllServicesInCompose(
      composeJson,
      false,
    );

    // Build updated services
    const updatedServices = Object.fromEntries(
      allServiceIds.map(id => {
        const service = composeJson.services?.[id];
        if (!service) {
          throw new Error(`Service ${id} not found`);
        }

        const initialLabels: readonly string[] = Array.isArray(service.labels)
          ? service.labels
          : Object.entries(service.labels || {}).map(([k, v]) => `${k}=${v}`);

        const { imageName } = parseImage(service.image);

        const agentEntry = (agentsJson.data || []).find(
          (agent: any) => agent.dockerHubRepoName === imageName,
        );

        const hasConductorType = initialLabels.some(label =>
          label.startsWith(`${LabelPrefix.CONDUCTOR}.type=`),
        );

        const finalLabels: readonly string[] =
          !agentEntry || hasConductorType
            ? initialLabels
            : (() => {
                const conductorLabel: string = (() => {
                  if (agentEntry.dockerHubRepoName === 'gluesync-core-hub') {
                    return `${LabelPrefix.CONDUCTOR}.type=core-hub`;
                  }
                  if (agentEntry.isTarget || agentEntry.isSource) {
                    return `${LabelPrefix.CONDUCTOR}.type=agent`;
                  }
                  return `${LabelPrefix.CONDUCTOR}.type=module`;
                })();

                return [...initialLabels, conductorLabel];
              })();

        return [id, { ...service, labels: finalLabels }];
      }),
    );

    const updatedComposeFile = { ...composeJson, services: updatedServices };
    await writeComposeFile(updatedComposeFile);

    reply.code(200).send({
      success: true,
      message: 'Conductor labels applied successfully',
      updatedIds: allServiceIds,
    });
  } catch (error) {
    reply.code(500).send({
      success: false,
      error: `Failed to apply conductor labels: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
};

export default handler;
