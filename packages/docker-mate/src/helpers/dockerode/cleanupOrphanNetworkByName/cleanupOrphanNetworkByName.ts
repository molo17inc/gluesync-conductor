import { CleanupOrphanNetworkByName } from './cleanupOrphanNetworkByName.model';

const cleanupOrphanNetworkByName: CleanupOrphanNetworkByName = async (
  docker,
  networkName,
) => {
  try {
    // List all networks to find the one with the specified name
    const networks = await docker.listNetworks();
    const targetNetworkInfo = networks.find(net => net.Name === networkName);

    if (!targetNetworkInfo) {
      return `Network ${networkName} not found. No action taken.`;
    }

    const containers = targetNetworkInfo.Containers;
    if (!containers || Object.keys(containers).length === 0) {
      // Network is orphan, safe to remove
      const network = docker.getNetwork(targetNetworkInfo.Id);
      await network.remove();
      return `Network ${networkName} removed successfully.`;
    }

    return `Network ${networkName} is still in use. Not removing.`;
  } catch (error) {
    return `Error cleaning network ${networkName}: ${error instanceof Error ? error.message : String(error)}`;
  }
};

export default cleanupOrphanNetworkByName;
