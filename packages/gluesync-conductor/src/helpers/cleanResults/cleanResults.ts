import { readComposeFile } from '../composeFile/readComposeFile/readComposeFile';
import { CleanResults } from './cleanResults.model';

const cleanResults: CleanResults = async results => {
  const composeJson = await readComposeFile({ raw: false });

  return results.map(result => {
    const serviceFound = composeJson?.services?.[result.serviceId];

    return result.success
      ? {
          success: true,
          serviceId: result.serviceId,
          service: serviceFound,
        }
      : {
          success: false,
          serviceId: result.serviceId,
          error: result.error,
        };
  });
};

export default cleanResults;
