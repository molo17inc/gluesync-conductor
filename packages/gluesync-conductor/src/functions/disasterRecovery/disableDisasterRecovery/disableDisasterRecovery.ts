import { refuseDisable } from '../refuseDisasterRecovery/refuseDisasterRecovery';
import runDisasterRecoveryChange from '../runDisasterRecoveryChange/runDisasterRecoveryChange';
import type { DisasterRecoveryHandler } from '../disasterRecovery.model';

/**
 * Takes out what the guided setup added: the GS_DR_* variables, the published ports, the
 * Chronos mount and its control URL. Anything else in the compose file stays. Only a setup
 * of this Conductor is undone: DR enabled by hand is the operator's to remove.
 */
const disableDisasterRecovery: DisasterRecoveryHandler = async (
  request,
  reply,
) => {
  await runDisasterRecoveryChange(request, reply, {
    action: 'dr-disable',
    refuse: refuseDisable,
    change: { kind: 'disable' },
    accepted: restarting => ({ restarting }),
  });
};

export default disableDisasterRecovery;
