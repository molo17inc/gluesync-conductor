import { RouteHandlerMethod } from 'fastify';

import { ErrorResponse } from '../../../models/common.model';
import {
  ComposePort,
  ComposeServiceDeploy,
  ComposeVolume,
  RawComposeFile,
  RawComposeService,
} from '../../../models/composeFile.model';

export type EditAgentsBody = Readonly<{
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
): Error & { status: number; serviceId: string; error: string } => {
  const error = new Error(message);
  return {
    message: error.message,
    name: error.name,
    stack: error.stack,
    status,
    serviceId,
    error: message,
  };
};

export type AgentResultItem =
  | {
      success: true;
      serviceId: string;
      service: RawComposeService;
    }
  | { success: false; serviceId: string; error: string };

export type EditAgentsSuccessResponse = {
  success: boolean;
  data: RawComposeFile;
  results: Array<AgentResultItem>;
};

export type EditAgentsResponse = EditAgentsSuccessResponse | ErrorResponse;

export type EditAgentsHandler = RouteHandlerMethod<
  any,
  any,
  any,
  {
    Body: Partial<EditAgentsBody>;
    Reply: EditAgentsResponse;
  }
>;
