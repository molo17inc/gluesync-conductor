import { RouteHandlerMethod } from 'fastify';
import { ErrorResponse } from '../../../models/common.model';

export type CollectLogsStreamingQuerystring = Readonly<{
  raw?: boolean;
}>;

export type CollectLogsStreamingBody = Readonly<{
  ticketId: string;
  email: string;
}>;

export type CollectLogsStreamingSuccessResponse = {
  success: true;
  output: string;
};

export type CollectLogsStreamingResponse =
  | CollectLogsStreamingSuccessResponse
  | ErrorResponse;

export type CollectLogsStreamingHandler = RouteHandlerMethod<
  any,
  any,
  any,
  {
    Querystring: CollectLogsStreamingQuerystring;
    Body: Partial<CollectLogsStreamingBody>;
    Reply: CollectLogsStreamingResponse;
  }
>;
