import {
  ComposeDependsOn,
  ComposeHealthcheck,
  ComposePort,
  ComposeServiceDeploy,
  ComposeVolume,
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
  }
>;

export type CreateComposeService = (
  type: ConductorServiceTypes,
  options: CreateComposeServiceOptions,
) => RawComposeService;
