import { RouteHandlerMethod } from 'fastify';

import { ErrorResponse, SuccessResponse } from '../../../models/common.model';
import { ContainerInfo, SystemInfo } from '../../../models/dockerode.model';
import { RawComposeService } from '../../../models/composeFile.model';

export type ListContainerItem = Readonly<{
  id: string;
  service?: RawComposeService;
  info?: ContainerInfo;
}>;

export type ListContainersSuccessResponse = Readonly<{
  containers: ReadonlyArray<ListContainerItem>;
  systemInfo: SystemInfo;
}>;

export type ListContainersResponse =
  | SuccessResponse<ListContainersSuccessResponse>
  | ErrorResponse;

export type ListContainersHandler = RouteHandlerMethod<
  any,
  any,
  any,
  {
    Reply: ListContainersResponse;
  }
>;
