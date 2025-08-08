import { RawComposeService } from '../../../models/composeFile.model';
import { ConductorServiceTypes } from '../../../models/conductor.model';

export type CreateComposeServiceOptions = Readonly<{
  imageName: string;
  type: string;
  nickname?: string;
  tag?: string;
  environment?: Record<string, string>;
  ports?: readonly string[];
  volumes?: readonly string[];
  labels?: Record<string, string>;
}>;

export type CreateComposeService = (
  type: ConductorServiceTypes,
  options: CreateComposeServiceOptions,
) => RawComposeService;
