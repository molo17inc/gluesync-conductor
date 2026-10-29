import mapService from '../mapService/mapService';
import { GetService } from './getService.model';

// Rejects with Docker's 404 error when the service does not exist
const getService: GetService = async (docker, fullName) =>
  mapService(await docker.getService(fullName).inspect());

export default getService;
