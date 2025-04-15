import type { RouteHandlerMethod } from 'fastify';
import { ErrorResponse, SuccessResponse } from '../../../models/common.model';

export type SystemInfo = {
  ncpu: number;
  memTotal: number;
};

export type Agent = {
  id: string;
  imageName: string;
  type: 'target' | 'source';
  nickname?: string;
  tag?: string;
  versionTag?: string;
  persisted?: boolean;
  environment?: string[];
  ports?: any[];
  volumes?: string[];
  hostConfig?: any;
};

export type GetAgentsSuccessResponse = {
  success: true;
  data: Agent[];
  systemInfo: SystemInfo;
};

export type GetAgentsResponse = GetAgentsSuccessResponse | ErrorResponse;

export type GetAgentsHandler = RouteHandlerMethod<
  any,
  any,
  any,
  {
    Reply: GetAgentsResponse;
  }
>;
