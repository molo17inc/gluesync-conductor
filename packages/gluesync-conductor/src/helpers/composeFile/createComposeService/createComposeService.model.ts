import {
  ComposeDependsOn,
  ComposeHealthcheck,
  ComposePort,
  ComposeServiceDeploy,
  ComposeVolume,
  EnvFile,
  RawComposeService,
} from '../../../models/composeFile.model';
import { ConductorServiceTypes } from '../../../models/conductor.model';

export type CreateComposeServiceOptions = Readonly<
  ComposeServiceDeploy & {
    id: string;
    serviceId: string;
    imageName: string;
    agentType?: string;
    nickname?: string;
    tag?: string;
    environment?: Record<string, string>;
    ports?: ReadonlyArray<string> | ReadonlyArray<ComposePort>;
    volumes?: ReadonlyArray<string> | ReadonlyArray<ComposeVolume>;
    labels?: Record<string, string>;
    healthcheck?: ComposeHealthcheck;
    dependsOn?: ComposeDependsOn;
    env_file?: EnvFile;
    // Docker Swarm stack file instead of compose (docs/swarm-mode.md)
    swarm?: Readonly<{
      // `deploy` of the service being edited: placement, replicas and the like
      // are not Conductor's to drop
      currentDeploy?: ComposeServiceDeploy;
    }>;
  }
>;

export type CreateComposeService = (
  type: ConductorServiceTypes,
  options: CreateComposeServiceOptions,
) => RawComposeService;
