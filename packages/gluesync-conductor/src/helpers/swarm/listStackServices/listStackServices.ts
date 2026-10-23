import { STACK_NAMESPACE_LABEL } from '../swarm.model';
import mapService from '../mapService/mapService';
import { ListStackServices } from './listStackServices.model';

// Services outside the stack (even in the same swarm) are not Conductor's
const listStackServices: ListStackServices = async (docker, namespace) =>
  (
    await docker.listServices({
      filters: { label: [`${STACK_NAMESPACE_LABEL}=${namespace}`] },
    })
  ).map(mapService);

export default listStackServices;
