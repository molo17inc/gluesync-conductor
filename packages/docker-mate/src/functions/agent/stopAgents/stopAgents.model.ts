import { RouteHandlerMethod } from 'fastify';

import { ErrorResponse, SuccessResponse } from '../../../models/common.model';

export type StopAgentsResponse = SuccessResponse<any> | ErrorResponse;

export type StopAgentsHandler = RouteHandlerMethod<
  any,
  any,
  any,
  {
    Reply: StopAgentsResponse;
  }
>;
