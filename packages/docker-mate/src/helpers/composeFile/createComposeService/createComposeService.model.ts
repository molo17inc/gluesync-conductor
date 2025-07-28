import { RawComposeService } from '../../../models/composeFile.model';

export type CreateComposeServiceOptions = {
  imageName: string;
  type: string;
  nickname?: string;
  tag?: string;
  environment?: Record<string, string>;
  ports?: readonly string[];
  volumes?: readonly string[];
  labels?: Record<string, string>;
};

export type CreateComposeService = (
  type: 'agent' | 'module' | 'container',
  options: CreateComposeServiceOptions,
) => RawComposeService;
