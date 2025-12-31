import { RouteHandlerMethod } from 'fastify';

import { ErrorResponse, SuccessResponse } from '../../../models/common.model';
import { ContainerInfo, SystemInfo } from '../../../models/dockerode.model';
import { ComposeService } from '../../../models/composeFile.model';
import { ConductorServiceTypes } from '../../../models/conductor.model';

export type ListContainerItem = Readonly<{
  id: string;
  type?: ConductorServiceTypes | 'unknown';
  persisted: boolean;
  agentId?: string;
  service?: ComposeService;
  info?: ContainerInfo;
}>;

export type ListContainersSuccessResponse = Readonly<{
  containers: ReadonlyArray<ListContainerItem>;
  systemInfo: SystemInfo;
}>;

export type ListContainersParams = Readonly<{
  type?: ConductorServiceTypes | 'unknown' | 'all';
}>;

export type ListContainersResponse =
  | SuccessResponse<ListContainersSuccessResponse>
  | ErrorResponse;

export type ListContainersHandler = RouteHandlerMethod<
  any,
  any,
  any,
  {
    Querystring: ListContainersParams;
    Reply: ListContainersResponse;
  }
>;
