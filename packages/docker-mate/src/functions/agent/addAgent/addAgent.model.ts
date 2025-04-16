import { RouteHandlerMethod } from 'fastify';

import { ErrorResponse, SuccessResponse } from '../../../models/common.model';

export type AddAgentBody = Readonly<{
  agents: ReadonlyArray<{
    imageName: string;
    type: 'target' | 'source';
    name?: string;
    tag?: string;
    environment?: Record<string, any>;
    ports?: ReadonlyArray<string>;
    volumes?: ReadonlyArray<string>;
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
