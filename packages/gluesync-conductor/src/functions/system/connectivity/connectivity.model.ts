import { RouteHandlerMethod } from 'fastify';
import { Diagnosis } from '../../../diagnosis/diagnosis.model';
import { ConnectivityScope } from '../../../diagnosis/runConnectivityCheck';
import { SuccessResponse } from '../../../models/common.model';

export type ConnectivityQuery = Readonly<{
  scope?: ConnectivityScope;
  refresh?: boolean;
}>;

export type ConnectivityHandler = RouteHandlerMethod<
  any,
  any,
  any,
  {
    Querystring: ConnectivityQuery;
    Reply: SuccessResponse<Diagnosis>;
  }
>;
