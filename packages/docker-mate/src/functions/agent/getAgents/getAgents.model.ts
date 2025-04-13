import { RouteHandlerMethod } from 'fastify';
import { ErrorResponse, SuccessResponse } from '../../../models/common.model';

export type Agent = {
  id: string;
  imageName: string;
  type: 'target' | 'source';
  nickname?: string;
  tag?: string;
  environment?: any;
  ports?: string[];
  volumes?: string[];
};

export type GetAgentsResponse = SuccessResponse<Agent[]> | ErrorResponse;

export type GetAgentsHandler = RouteHandlerMethod<
  any,
  any,
  any,
  {
    Reply: GetAgentsResponse;
  }
>;
