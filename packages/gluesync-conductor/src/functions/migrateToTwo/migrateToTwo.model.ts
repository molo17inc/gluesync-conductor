import { RouteHandlerMethod } from 'fastify';
import { ErrorResponse } from '../../models/common.model';

export type MigrateToTwoSuccessResponse = {
  success: true;
  data: string;
};

export type MigrateToTwoResponse = MigrateToTwoSuccessResponse | ErrorResponse;

export type MigrateToTwoHandler = RouteHandlerMethod<
  any,
  any,
  any,
  {
    Reply: MigrateToTwoResponse;
  }
>;
