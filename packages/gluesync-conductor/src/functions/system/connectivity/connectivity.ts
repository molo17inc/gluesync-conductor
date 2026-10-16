import runConnectivityCheck from '../../../diagnosis/runConnectivityCheck';
import { ConnectivityHandler } from './connectivity.model';

/**
 * Runs the connectivity sieve and returns its diagnosis. The request always
 * succeeds when the check itself ran, even if it found a problem: the finding
 * is the payload, not an HTTP error.
 */
const handler: ConnectivityHandler = async (req, reply) => {
  const { scope, refresh } = req.query;
  const diagnosis = await runConnectivityCheck({ scope, refresh });

  reply.code(200).send({ success: true, data: diagnosis });
};

export default handler;
