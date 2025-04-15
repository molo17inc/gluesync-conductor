import { RouteHandlerMethod } from 'fastify';

import { ErrorResponse, SuccessResponse } from '../../../models/common.model';

export type RestartContainerResponse = SuccessResponse<string[]> | ErrorResponse;

export type RestartContainerHandler = RouteHandlerMethod<
  any,
  any,
  any,
  {
    Params: {
      id: string;
    };
    Reply: RestartContainerResponse;
  }
>;
