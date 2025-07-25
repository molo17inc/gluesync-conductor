import { RouteHandlerMethod } from 'fastify';

import { ErrorResponse, SuccessResponse } from '../../../models/common.model';
import { ContainerInfo, SystemInfo } from '../../../models/dockerode.model';
import { ComposeService } from '../../../models/composeFile.model';

export type ListContainerItem = Readonly<{
  name: string;
  service?: ComposeService;
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
