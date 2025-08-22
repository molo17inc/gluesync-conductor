import { RouteHandlerMethod } from 'fastify';
import { ErrorResponse, SuccessResponse } from '../../../models/common.model';

export type GetAgentVersionSuccessResponse = Readonly<{
  currentVersion?: Readonly<string>;
  latestVersionAlpha?: Readonly<string>;
  latestVersionBeta?: Readonly<string>;
  latestVersionGA?: Readonly<string>;
}>;

export type GetAgentVersionParams = Readonly<{
  id: Readonly<string>;
}>;

export type GetAgentVersionResponse =
  | SuccessResponse<GetAgentVersionSuccessResponse>
  | ErrorResponse;

export type GetAgentVersionHandler = RouteHandlerMethod<
  any,
  any,
  any,
  {
    Params: GetAgentVersionParams;
    Reply: GetAgentVersionResponse;
  }
>;
