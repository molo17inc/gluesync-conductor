import { RouteHandlerMethod } from 'fastify';
import { ErrorResponse } from '../../../models/common.model';
import {
  ComposeService,
  RawComposeService,
} from '../../../models/composeFile.model';

export type GetServicesSuccessResponse = {
  success: boolean;
  data?: Record<string, ComposeService> | Record<string, RawComposeService>;
};

export type GetServicesResponse = GetServicesSuccessResponse | ErrorResponse;

export type GetServicesQuerystring = Readonly<{
  raw?: boolean;
}>;

export type GetServicesParams = Readonly<{
  id?: Readonly<string>;
}>;

export type GetServicesHandler = RouteHandlerMethod<
  any,
  any,
  any,
  {
    Querystring: GetServicesQuerystring;
    Params: GetServicesParams;
    Reply: GetServicesResponse;
  }
>;
