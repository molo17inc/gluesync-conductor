import { RouteHandlerMethod } from 'fastify';

import { ErrorResponse, SuccessResponse } from '../../../models/common.model';

export type RemoveAgentResponse = Readonly<{
  success: boolean;
  data?: Record<string, any>;
  error?: string;
}>;

export type RemoveAgentHandler = RouteHandlerMethod<
  any,
  any,
  any,
  {
    Params: {
      id: string;
    };
    Reply: RemoveAgentResponse;
  }
>;
