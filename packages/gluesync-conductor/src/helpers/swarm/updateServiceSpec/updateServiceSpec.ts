import { getLogger } from '../../../utils/logger';
import getService from '../getService/getService';
import { UpdateServiceSpec } from './updateServiceSpec.model';

const isOutOfSequence = (error: unknown): boolean =>
  /update out of sequence/i.test(
    error instanceof Error ? error.message : String(error),
  );

/**
 * The one place that talks to `POST /services/{id}/update`. The API needs the
 * current `version` and the whole spec (anything left out is reset), so every
 * change is expressed as a function of the current spec.
 *
 * dockerode sends the object it is given as the body and as the query string
 * alike, unless it carries `_query` and `_body`.
 */
const updateServiceSpec: UpdateServiceSpec = async (
  docker,
  fullName,
  change,
  { query = {} } = {},
) => {
  const attempt = async (retriesLeft: number) => {
    const current = await getService(docker, fullName);

    try {
      await docker.getService(fullName).update({
        _query: { ...query, version: current.version },
        _body: change(current.spec, current),
      });

      return current;
    } catch (error) {
      // Somebody else (the orchestrator, a stack deploy) changed the service
      // between our read and our write
      if (retriesLeft > 0 && isOutOfSequence(error)) {
        getLogger().warn(
          { service: fullName },
          '[swarm] service changed while updating it, retrying',
        );

        return attempt(retriesLeft - 1);
      }

      throw error;
    }
  };

  return attempt(1);
};

export default updateServiceSpec;
