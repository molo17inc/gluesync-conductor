import { RouteHandlerMethod } from 'fastify';

import { ErrorResponse, SuccessResponse } from '../../../models/common.model';

export type StartAgentsResponse = SuccessResponse<any> | ErrorResponse;

export type StartAgentsHandler = RouteHandlerMethod<
  any,
  any,
  any,
  {
    Params: {
      id: string;
    };
    Reply: StartAgentsResponse;
  }
>;
