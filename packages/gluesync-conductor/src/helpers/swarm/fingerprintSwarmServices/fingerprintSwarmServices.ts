import getService from '../getService/getService';
import { FingerprintSwarmServices } from './fingerprintSwarmServices.model';

const isNotFound = (error: unknown): boolean =>
  (error as { statusCode?: number })?.statusCode === 404;

/**
 * What the services of the update set look like right now: the spec version
 * (it moves with every change, a rollback included) and the image. Used before
 * an update to tell later which services it actually touched. A service that
 * does not exist yet has a fingerprint of its own. One API call per service.
 */
const fingerprintSwarmServices: FingerprintSwarmServices = async (
  docker,
  namespace,
  ids,
) => {
  const entries = await Promise.all(
    ids.map(async id => {
      try {
        const { version, image } = await getService(
          docker,
          `${namespace}_${id}`,
        );

        return [id, `${version}@${image}`] as const;
      } catch (error) {
        if (isNotFound(error)) {
          return [id, 'absent'] as const;
        }

        throw error;
      }
    }),
  );

  return Object.fromEntries(entries);
};

export default fingerprintSwarmServices;
