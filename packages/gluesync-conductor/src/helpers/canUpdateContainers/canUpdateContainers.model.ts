import { RawComposeFile } from '../../models/composeFile.model';
import { ReleaseChannelTypes } from '../../models/conductor.model';

export type CanUpdateContainersOptions = Readonly<{
  // The stack file has no type label to add: a service without one is typed
  // from its image, as autoAdoptServices would have done in compose mode
  swarm?: boolean;
}>;

export type CanUpdateContainers = (
  containerIds: ReadonlyArray<string>,
  composeJson: RawComposeFile,
  releaseChannel: ReleaseChannelTypes,
  options?: CanUpdateContainersOptions,
) => Promise<{
  success: boolean;
  errors: (string | null)[];
  message: string;
  data?: Readonly<{
    agentVersion: string | null;
    modules: ReadonlyArray<{
      id: string;
      version: string | null;
    }>;
    // Modules left out because their latest version could not be fetched;
    // the rest of the update goes ahead without them.
    skipped: ReadonlyArray<{ id: string; reason: string }>;
  }>;
}>;
