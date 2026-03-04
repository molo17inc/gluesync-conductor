import { RouteHandlerMethod } from 'fastify';
import { ErrorResponse, SuccessResponse } from '../../models/common.model';

export type MigrateToTwoResponse = SuccessResponse<string> | ErrorResponse;

export type MigrateToTwoHandler = RouteHandlerMethod<
  any,
  any,
  any,
  {
    Reply: MigrateToTwoResponse;
  }
>;
