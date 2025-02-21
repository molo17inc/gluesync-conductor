import { RouteHandlerMethod } from 'fastify';

import { ErrorResponse, SuccessResponse } from '../../../models/common.model';

export type AddAgentBody = Readonly<{
  agents: ReadonlyArray<{
    dockerHubRepoName: string;
    isTarget?: boolean;
    isSource?: boolean;
  }>;
}>;
export type AddAgentResponse = SuccessResponse<any> | ErrorResponse;

export type AddAgentHandler = RouteHandlerMethod<
  any,
  any,
  any,
  {
    Body: Partial<AddAgentBody>;
    Reply: AddAgentResponse;
  }
>;
