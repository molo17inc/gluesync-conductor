import { RouteHandlerMethod } from 'fastify';

import { ErrorResponse, SuccessResponse } from '../../../models/common.model';

// Define and export the params interface explicitly
export interface RestartContainerParams {
  id: string;
}

export type RestartContainerResponse =
  | SuccessResponse<string[]>
  | ErrorResponse;

export type RestartContainerHandler = RouteHandlerMethod<
  any,
  any,
  any,
  {
    Params: RestartContainerParams;
    Reply: RestartContainerResponse;
  }
>;
