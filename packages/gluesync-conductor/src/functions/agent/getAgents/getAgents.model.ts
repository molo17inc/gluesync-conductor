import { RouteHandlerMethod } from 'fastify';
import { ErrorResponse } from '../../../models/common.model';
import { ComposeService } from '../../../models/composeFile.model';

export type GetAgentsSuccessResponse = {
  success: boolean;
  data?: Record<string, ComposeService>;
};

export type GetAgentsResponse = GetAgentsSuccessResponse | ErrorResponse;

export type GetAgentsParams = Readonly<{
  id?: Readonly<string>;
}>;

export type GetAgentsHandler = RouteHandlerMethod<
  any,
  any,
  any,
  {
    Params: GetAgentsParams;
    Reply: GetAgentsResponse;
  }
>;
