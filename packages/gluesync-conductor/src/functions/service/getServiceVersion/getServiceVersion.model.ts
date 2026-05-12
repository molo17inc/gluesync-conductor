import { RouteHandlerMethod } from 'fastify';
import { ErrorResponse, SuccessResponse } from '../../../models/common.model';
import { ReleaseChannelTypes } from '../../../models/conductor.model';
import { ChangelogResponse } from '../../../helpers/fetchChangelogInfo/fetchChangelogInfo.model';

export type GetServiceVersionSuccessResponse = Readonly<{
  currentVersion?: Readonly<string>;
  latestVersionAlpha?: Readonly<string>;
  latestVersionBeta?: Readonly<string>;
  latestVersionGA?: Readonly<string>;
  mandatoryUpdate: boolean;
  servicesToUpdate: ReadonlyArray<string>;
  changelogData?: Omit<ChangelogResponse, 'id'>;
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
