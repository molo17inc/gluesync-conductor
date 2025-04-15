import { RouteHandlerMethod } from 'fastify';

import { ErrorResponse, SuccessResponse } from '../../../models/common.model';

// Define and export the params interface explicitly
export interface PullContainerParams {
  id: string;
}

export type PullContainerResponse = SuccessResponse<string[]> | ErrorResponse;

export type PullContainerHandler = RouteHandlerMethod<
  any,
  any,
  any,
  {
    Params: PullContainerParams;
    Reply: PullContainerResponse;
  }
>;
