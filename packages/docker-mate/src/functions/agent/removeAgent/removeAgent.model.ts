import { RouteHandlerMethod } from 'fastify';

import { ErrorResponse, SuccessResponse } from '../../../models/common.model';

export type RemoveAgentBody = Readonly<{
  agents: ReadonlyArray<{
    imageName: string;
    type: 'target' | 'source';
  }>;
}>;
export type RemoveAgentResponse = SuccessResponse<any> | ErrorResponse;

export type RemoveAgentHandler = RouteHandlerMethod<
  any,
  any,
  any,
  {
    Body: Partial<RemoveAgentBody>;
    Reply: RemoveAgentResponse;
  }
>;
