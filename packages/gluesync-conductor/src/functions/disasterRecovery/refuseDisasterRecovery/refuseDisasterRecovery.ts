import type { DisasterRecoveryInspection } from '../../../helpers/disasterRecoverySetup/disasterRecoverySetup.model';
import type { Refusal } from '../runDisasterRecoveryChange/runDisasterRecoveryChange.model';

/** A setup needs a host that supports it, and no disaster recovery yet. */
export const refuseSetup = ({
  state,
}: Readonly<DisasterRecoveryInspection>): Refusal | null => {
  if (state.enabled) {
    return {
      error: 'Disaster recovery is already enabled on this Core Hub',
      details: state.managedByConductor
        ? 'Disable it first to set it up again'
        : 'It was set up by hand: change the GS_DR_* variables where they are set',
    };
  }

  return state.supported
    ? null
    : {
        error: 'Disaster recovery cannot be set up here',
        details: state.reason ?? 'This installation is not supported',
      };
};

/** Only a setup of this Conductor is undone by it: the rest is the operator's own. */
export const refuseDisable = ({
  state,
  mode,
  compose,
  targets,
}: Readonly<DisasterRecoveryInspection>): Refusal | null => {
  if (mode === 'swarm') {
    return {
      error: 'Disaster recovery cannot be changed here',
      details: state.reason ?? 'Docker Swarm is not managed by the Conductor',
    };
  }

  if (!state.enabled) {
    return {
      error: 'Disaster recovery is not enabled on this Core Hub',
      details: 'There is nothing to disable',
    };
  }

  if (!state.managedByConductor) {
    return {
      error: 'Disaster recovery was not set up by this Conductor',
      details:
        'It was set up by hand: remove the GS_DR_* variables where they are set',
    };
  }

  const services = compose?.services ?? {};

  return services[targets.coreHub] && services[targets.chronos]
    ? null
    : {
        error: 'Disaster recovery cannot be disabled here',
        details: `The services "${targets.coreHub}" and "${targets.chronos}" must both be in the compose file`,
      };
};
