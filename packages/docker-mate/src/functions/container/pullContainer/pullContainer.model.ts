import { RouteHandlerMethod } from 'fastify';

import { ErrorResponse, SuccessResponse } from '../../../models/common.model';

export type PullContainerResponse = SuccessResponse<string[]> | ErrorResponse;

export type PullContainerHandler = RouteHandlerMethod<
  any,
  any,
  any,
  {
    Params: {
      id: string;
    };
    Reply: PullContainerResponse;
  }
>;
