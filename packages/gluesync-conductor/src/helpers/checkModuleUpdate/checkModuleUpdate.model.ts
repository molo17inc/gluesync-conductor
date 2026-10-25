import type Docker from 'dockerode';
import type { ReleaseChannelTypes } from '../../models/conductor.model';

export type CheckModuleUpdateResult = Readonly<{
  needsUpdate: boolean;
  id: string;
  availableVersion: string | null;
  // Swarm mode only: why the Conductor must not move to `availableVersion`
  // (not newer than the running one, or the running one is a dev build). Then
  // `needsUpdate` is false.
  refusal?: string;
}>;

export type CheckModuleUpdateParams = Readonly<{
  composeJson: Readonly<Record<string, unknown>>;
  releaseChannel: ReleaseChannelTypes;
  serviceName: string;
}>;

export type CheckModuleUpdate = (
  docker: Readonly<Docker>,
  composeJson: Readonly<Record<string, unknown>>,
  releaseChannel: ReleaseChannelTypes,
  serviceName: string,
) => Promise<CheckModuleUpdateResult | null>;
