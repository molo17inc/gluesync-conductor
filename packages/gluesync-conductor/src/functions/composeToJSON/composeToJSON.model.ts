import { RouteHandlerMethod } from 'fastify';

import { ErrorResponse, SuccessResponse } from '../../models/common.model';

export type ComposeToJSONParams = Readonly<{
  raw?: boolean;
}>;
export type ComposeToJSONResponse = SuccessResponse<any> | ErrorResponse;

export type ComposeToJSONHandler = RouteHandlerMethod<
  any,
  any,
  any,
  {
    Querystring: ComposeToJSONParams;
    Reply: ComposeToJSONResponse;
  }
>;
