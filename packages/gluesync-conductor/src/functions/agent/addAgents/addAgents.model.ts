import { RouteHandlerMethod } from 'fastify';

import { ErrorResponse } from '../../../models/common.model';
import {
  ComposePort,
  ComposeServiceDeploy,
  ComposeVolume,
  RawComposeFile,
  RawComposeService,
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

// export type AgentResultItem = {
//   success: boolean;
//   error?: string;
//   serviceId: string;
// };

export const createAgentError = (
  message: string,
  status: number,
  serviceId: string,
): Error & { status: number; serviceId: string } => {
  const error = new Error(message);
  return {
    ...error, // copy native Error properties (message, stack, name)
    status,
    serviceId,
  };
};

export type AgentResultItem =
  | {
      success: true;
      serviceId: string;
      service: RawComposeService;
    }
  | { success: false; serviceId: string; error: string };

export type AddAgentsSuccessResponse = {
  success: boolean;
  data: RawComposeFile;
  results: Array<AgentResultItem>;
};

export type AddAgentsResponse = AddAgentsSuccessResponse | ErrorResponse;

export type AddAgentsHandler = RouteHandlerMethod<
  any,
  any,
  any,
  {
    Body: Partial<AddAgentsBody>;
    Reply: AddAgentsResponse;
  }
>;
