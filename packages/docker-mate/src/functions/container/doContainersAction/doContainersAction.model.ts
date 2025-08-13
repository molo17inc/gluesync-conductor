import { RouteHandlerMethod } from 'fastify';

import { ErrorResponse, SuccessResponse } from '../../../models/common.model';
import { ContainerActions } from '../../../models/conductor.model';

export type DoContainersActionItem = Readonly<{
  id: string;
  status: 'OK' | 'ERRROR';
  message: string;
}>;

export type DoContainersActionSuccessResponse = Readonly<{
  containers: ReadonlyArray<DoContainersActionItem>;
}>;

export type DoContainersActionBody = Readonly<{
  action: ContainerActions;
  ids: ReadonlyArray<string>;
}>;

export type DoContainersActionResponse =
  | SuccessResponse<DoContainersActionSuccessResponse>
  | ErrorResponse;

export type DoContainersActionHandler = RouteHandlerMethod<
  any,
  any,
  any,
  {
    Body: DoContainersActionBody;
    Reply: DoContainersActionResponse;
  }
>;
