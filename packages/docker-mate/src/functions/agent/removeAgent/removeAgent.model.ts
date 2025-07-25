import { RouteHandlerMethod } from 'fastify';

import { ErrorResponse, SuccessResponse } from '../../../models/common.model';

export type RemoveAgentResponse = SuccessResponse<any> | ErrorResponse;

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
