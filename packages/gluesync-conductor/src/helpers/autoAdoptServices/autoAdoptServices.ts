import { LabelPrefix } from '../../models/composeFile.model';
import { readComposeFile } from '../composeFile/readComposeFile/readComposeFile';
import writeComposeFile from '../composeFile/writeComposeFile/writeComposeFile';
import fetchAllServicesInCompose from '../fetchAllServicesInCompose/fetchAllServicesInCompose';
import parseImage from '../parseImage/parseImage';
import agentsJson from '../../../../../agents.json';

/**
 * Function to apply conductor labels to services in docker-compose.yml.
 * Services with type labels will be handled by Conductor
 */
const autoAdoptServices = async (): Promise<{
  success: boolean;
  updatedIds: readonly string[];
}> => {
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

    return {
      success: true,
      updatedIds: allServiceIds,
    };
  } catch (error) {
    console.error(
      `Failed to apply conductor labels: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {
      success: false,
      updatedIds: [],
    };
  }
};

export default autoAdoptServices;
