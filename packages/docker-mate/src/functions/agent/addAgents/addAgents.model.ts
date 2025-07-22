import { RouteHandlerMethod } from 'fastify';

import { ErrorResponse, SuccessResponse } from '../../../models/common.model';

export type AddAgentsBody = Readonly<{
  agents: ReadonlyArray<{
    imageName: string;
    type: 'target' | 'source';
    nickname?: string;
    tag?: string;
    environment?: Record<string, any>;
    labels: Record<string, any>;
    ports?: ReadonlyArray<string>;
    volumes?: ReadonlyArray<string>;
  }>;
}>;
export type AddAgentsResponse = SuccessResponse<any> | ErrorResponse;

export type AddAgentsHandler = RouteHandlerMethod<
  any,
  any,
  any,
  {
    Body: Partial<AddAgentsBody>;
    Reply: AddAgentsResponse;
  }
>;
