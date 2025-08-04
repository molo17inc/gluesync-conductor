import { RouteHandlerMethod } from 'fastify';

import { ErrorResponse, SuccessResponse } from '../../../models/common.model';
import {
  ComposePort,
  ComposeServiceDeploy,
  ComposeVolume,
} from '../../../models/composeFile.model';

export type AddAgentsBody = Readonly<{
  agents: ReadonlyArray<
    ComposeServiceDeploy['resources'] & {
      imageName: string;
      type: 'target' | 'source';
      nickname?: string;
      tag?: string;
      environment?: Record<string, any>;
      labels: Record<string, any>;
      ports?: ReadonlyArray<ComposePort>;
      volumes?: ReadonlyArray<ComposeVolume>;
    }
  >;
}>;
export type AddAgentsResponse = SuccessResponse<any> | ErrorResponse;

export type AddAgentsHandler = RouteHandlerMethod<
  any,
  any,
  any,
  {
    Body: Partial<AddAgentsBody>;
    Reply: AddAgentsResponse;
  }
>;
