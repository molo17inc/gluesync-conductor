import { RouteHandlerMethod } from 'fastify';
import { ErrorResponse } from '../../../models/common.model';
import {
  ComposeService,
  RawComposeService,
} from '../../../models/composeFile.model';

export type GetAgentsSuccessResponse = {
  success: boolean;
  data?: Record<string, ComposeService> | Record<string, RawComposeService>;
};

export type GetAgentsResponse = GetAgentsSuccessResponse | ErrorResponse;

export type GetAgentsQuerystring = Readonly<{
  raw?: boolean;
}>;

export type GetAgentsParams = Readonly<{
  id?: Readonly<string>;
}>;

export type GetAgentsHandler = RouteHandlerMethod<
  any,
  any,
  any,
  {
    Querystring: GetAgentsQuerystring;
    Params: GetAgentsParams;
    Reply: GetAgentsResponse;
  }
>;
