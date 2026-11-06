import {
  encodePairingCode,
  generateSecret,
  validateFirstSiteRequest,
} from '../../../helpers/disasterRecoveryPairing/disasterRecoveryPairing';
import { refuseSetup } from '../refuseDisasterRecovery/refuseDisasterRecovery';
import runDisasterRecoveryChange from '../runDisasterRecoveryChange/runDisasterRecoveryChange';
import type {
  DisasterRecoveryHandler,
  FirstSiteBody,
} from '../disasterRecovery.model';

/**
 * Sets this site up as the first of a pair: it keeps its data and starts active. The
 * answer carries the pairing code for the second site, which holds the shared secret of the
 * pair: it is returned once and never logged.
 */
const setupFirstSite: DisasterRecoveryHandler = async (request, reply) => {
  const checked = validateFirstSiteRequest(request.body as FirstSiteBody);

  if (!checked.valid) {
    reply.code(400).send({
      success: false,
      error: 'Invalid disaster recovery setup',
      details: checked.problems.join('; '),
    });
    return;
  }

  const { thisSite, peerSite, failoverMode, witnessUrl, leaseTtlSeconds } =
    checked.value;
  const sharedSecret = generateSecret();
  const adminToken = generateSecret();
  const pairingCode = encodePairingCode({
    v: 1,
    secret: sharedSecret,
    failoverMode,
    witnessUrl,
    leaseTtlSeconds,
    first: thisSite,
    joiner: peerSite,
  });

  await runDisasterRecoveryChange(request, reply, {
    action: 'dr-setup-first',
    refuse: refuseSetup,
    change: {
      kind: 'enable',
      variables: {
        nodeId: thisSite.nodeId,
        peerUrl: peerSite.url,
        failoverMode,
        witnessUrl,
        leaseTtlSeconds,
        sharedSecret,
        adminToken,
        bootstrapActive: true,
      },
    },
    accepted: restarting => ({
      pairingCode,
      operatorToken: adminToken,
      restarting,
    }),
  });
};

export default setupFirstSite;
