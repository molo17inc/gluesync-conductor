import { LabelPrefix } from '../../models/composeFile.model';
import { readComposeFile } from '../composeFile/readComposeFile/readComposeFile';
import writeComposeFile from '../composeFile/writeComposeFile/writeComposeFile';
import fetchAllServicesInCompose from '../fetchAllServicesInCompose/fetchAllServicesInCompose';
import parseImage from '../parseImage/parseImage';
import agentsJson from '../../../agents.json';

/**
 * Function to apply Conductor labels to services in docker-compose.yml.
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

    const { updatedServices, updatedIds } = allServiceIds.reduce(
      (acc, id) => {
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

        if (!agentEntry || hasConductorType) {
          return {
            updatedServices: {
              ...acc.updatedServices,
              [id]: { ...service, labels: initialLabels },
            },
            updatedIds: acc.updatedIds,
          };
        }

        const conductorLabel: string = (() => {
          if (agentEntry.dockerHubRepoName === 'gluesync-core-hub') {
            return `${LabelPrefix.CONDUCTOR}.type=core-hub`;
          }
          if (agentEntry.isTarget || agentEntry.isSource) {
            return `${LabelPrefix.CONDUCTOR}.type=agent`;
          }
          return `${LabelPrefix.CONDUCTOR}.type=module`;
        })();

        const finalLabels = [...initialLabels, conductorLabel];

        return {
          updatedServices: {
            ...acc.updatedServices,
            [id]: { ...service, labels: finalLabels },
          },
          updatedIds: [...acc.updatedIds, id],
        };
      },
      { updatedServices: {}, updatedIds: [] as ReadonlyArray<string> },
    );

    const updatedComposeFile = { ...composeJson, services: updatedServices };
    await writeComposeFile(updatedComposeFile);

    return {
      success: true,
      updatedIds,
    };
  } catch (error) {
    console.error(
      `Failed to apply Conductor labels: ${
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
