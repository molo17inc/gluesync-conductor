import {
  ComposePort,
  ComposeServiceDeploy,
  RawComposeService,
} from '../../../models/composeFile.model';
import { ConductorServiceTypes } from '../../../models/conductor.model';

export type CreateComposeServiceOptions = Readonly<
  ComposeServiceDeploy & {
    imageName: string;
    type: string;
    nickname?: string;
    tag?: string;
    environment?: Record<string, string>;
    ports?: ReadonlyArray<string> | ReadonlyArray<ComposePort>;
    volumes?: ReadonlyArray<string>;
    labels?: Record<string, string>;
  }
>;

export type CreateComposeService = (
  type: ConductorServiceTypes,
  options: CreateComposeServiceOptions,
) => RawComposeService;
