import { RouteHandlerMethod } from 'fastify';
import { ErrorResponse, SuccessResponse } from '../../../models/common.model';
import { ReleaseChannelTypes } from '../../../models/conductor.model';

export type GetServiceVersionSuccessResponse = Readonly<{
  currentVersion?: Readonly<string>;
  latestVersionAlpha?: Readonly<string>;
  latestVersionBeta?: Readonly<string>;
  latestVersionGA?: Readonly<string>;
  mandatoryUpdate: boolean;
}>;

export type GetServiceVersionParams = Readonly<{
  id: Readonly<string>;
  releaseChannel?: Readonly<ReleaseChannelTypes>;
}>;

export type GetServiceVersionResponse =
  | SuccessResponse<GetServiceVersionSuccessResponse>
  | ErrorResponse;

export type GetServiceVersionHandler = RouteHandlerMethod<
  any,
  any,
  any,
  {
    Params: GetServiceVersionParams;
    Reply: GetServiceVersionResponse;
  }
>;
