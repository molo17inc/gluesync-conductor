import {
  decodePairingCode,
  generateSecret,
} from '../../../helpers/disasterRecoveryPairing/disasterRecoveryPairing';
import { PairingCodeError } from '../../../helpers/disasterRecoveryPairing/disasterRecoveryPairing.errors';
import {
  probeWitness,
  witnessJoinRefusal,
} from '../../../helpers/disasterRecoveryWitness/disasterRecoveryWitness';
import { refuseSetup } from '../refuseDisasterRecovery/refuseDisasterRecovery';
import runDisasterRecoveryChange from '../runDisasterRecoveryChange/runDisasterRecoveryChange';
import type {
  DisasterRecoveryHandler,
  JoinBody,
} from '../disasterRecovery.model';

/**
 * Sets this site up as the second of a pair, from the pairing code of the first. This site
 * becomes the standby: it moves its own databases aside and follows the first one, which is
 * what `confirmDataMovedAside` acknowledges. It gets an operator token of its own. With a witness,
 * the witness must already run with the shared secret of the pair: this site has to get the
 * lease from it, so a witness that does not answer, or refuses the signature, refuses the join
 * with 409 once the host checks have passed and before anything is changed.
 */
const joinSecondSite: DisasterRecoveryHandler = async (request, reply) => {
  const { pairingCode } = request.body as JoinBody;
  const decoded = (():
    | ReturnType<typeof decodePairingCode>
    | PairingCodeError => {
    try {
      return decodePairingCode(pairingCode);
    } catch (error) {
      if (error instanceof PairingCodeError) {
        return error;
      }
      throw error;
    }
  })();

  if (decoded instanceof PairingCodeError) {
    reply.code(400).send({
      success: false,
      error: 'Invalid pairing code',
      details: decoded.message,
    });
    return;
  }

  const { secret, failoverMode, witnessUrl, leaseTtlSeconds, first, joiner } =
    decoded;
  const adminToken = generateSecret();

  await runDisasterRecoveryChange(request, reply, {
    action: 'dr-setup-join',
    refuse: refuseSetup,
    // Once the host is known to take the change, under the lock, before anything is written
    preflight: async () => ({
      refusal:
        witnessUrl === null
          ? null
          : witnessJoinRefusal(
              witnessUrl,
              await probeWitness(witnessUrl, { nodeId: joiner.nodeId, secret }),
              joiner.nodeId,
            ),
    }),
    change: {
      kind: 'enable',
      variables: {
        nodeId: joiner.nodeId,
        peerUrl: first.url,
        failoverMode,
        witnessUrl,
        leaseTtlSeconds,
        sharedSecret: secret,
        adminToken,
        bootstrapActive: false,
      },
    },
    accepted: restarting => ({
      operatorToken: adminToken,
      nodeId: joiner.nodeId,
      peerUrl: first.url,
      restarting,
    }),
  });
};

export default joinSecondSite;
