import {
  ComposeService,
  RawComposeService,
} from '../../../models/composeFile.model';
import { ConductorServiceTypes } from '../../../models/conductor.model';

type StackService = Readonly<ComposeService | RawComposeService>;

// The `com.molo17.conductor.type` label of the stack file, on the service or
// under `deploy.labels`, as list or map. Nothing is inferred.
export type DeclaredStackServiceType = (
  service?: StackService,
) => ConductorServiceTypes | null;

// The declared type, else the one autoAdoptServices would have written. Swarm
// mode only: the stack file is never edited, so the type is worked out on read.
export type StackServiceType = (
  id: string,
  service?: StackService,
) => ConductorServiceTypes | undefined;
