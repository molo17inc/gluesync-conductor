import { RouteHandlerMethod } from 'fastify';

import { ErrorResponse, SuccessResponse } from '../../../models/common.model';
import { SystemInfo } from '../getContainer/getContainer.model';
import { ContainerInfo } from '../../../models/dockerode.model';

export type ListContainerItem = Readonly<{
  info: ContainerInfo;
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
