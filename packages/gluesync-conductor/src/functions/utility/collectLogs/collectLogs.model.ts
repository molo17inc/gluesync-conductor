import { RouteHandlerMethod } from 'fastify';
import { ErrorResponse } from '../../../models/common.model';

export type CollectLogsQuerystring = Readonly<{
  raw?: boolean;
}>;

export type CollectLogsBody = Readonly<{
  ticketId?: string;
  email?: string;
  localOnly?: boolean;
}>;

export type CollectLogsSuccessResponse = Readonly<{
  success: true;
  output: string;
  archivePath?: string;
}>;

export type CollectLogsResponse = CollectLogsSuccessResponse | ErrorResponse;

export type CollectLogsRoute = Readonly<{
  Querystring: CollectLogsQuerystring;
  Body: CollectLogsBody;
  Reply: CollectLogsResponse;
}>;

export type CollectLogsHandler = RouteHandlerMethod<
  any,
  any,
  any,
  CollectLogsRoute
>;
