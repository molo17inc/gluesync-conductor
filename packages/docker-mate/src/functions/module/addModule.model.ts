import { RouteHandlerMethod } from 'fastify';

import { ErrorResponse, SuccessResponse } from '../../models/common.model';

export type AddModuleBody = Readonly<{
  modules: ReadonlyArray<{
    imageName: string;
    type: string;
    nickname?: string;
    tag?: string;
    environment?: Record<string, any>;
    labels?: Record<string, any>;
    ports?: ReadonlyArray<string>;
    volumes?: ReadonlyArray<string>;
  }>;
}>;

export type AddModuleResponse = SuccessResponse<any> | ErrorResponse;

export type AddModuleHandler = RouteHandlerMethod<
  any,
  any,
  any,
  {
    Body: Partial<AddModuleBody>;
    Reply: AddModuleResponse;
  }
>;
