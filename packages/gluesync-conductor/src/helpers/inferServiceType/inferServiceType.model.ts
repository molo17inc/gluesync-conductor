import { ConductorServiceTypes } from '../../models/conductor.model';

/**
 * The type a service gets when Conductor adopts it (labels it), decided from
 * its id and image alone: a third-party name, then agents.json. `null` when
 * nothing matches.
 */
export type InferServiceType = (
  id: string,
  image?: string,
) => ConductorServiceTypes | null;

// agents.json only, for a service known not to be third-party
export type InferTypeFromAgentsJson = (
  imageName: string,
) => ConductorServiceTypes | null;
