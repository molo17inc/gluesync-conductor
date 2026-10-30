import { RouteHandlerMethod } from 'fastify';
import { ErrorResponse } from '../../../models/common.model';

export type UploadedVia = 'portal' | 'webdav' | 'ftp';

export type CollectLogsQuerystring = Readonly<{
  raw?: boolean;
}>;

export type CollectLogsBody = Readonly<{
  voucher?: string;
  ticketId?: string;
  email?: string;
  localOnly?: boolean;
}>;

export type CollectLogsSuccessResponse = Readonly<{
  success: true;
  output: string;
  archivePath?: string;
  uploadedVia?: UploadedVia;
  ticketKey?: string;
  size?: number;
  verified?: boolean;
}>;

export type CollectLogsErrorResponse = ErrorResponse &
  Readonly<{
    /** Why the upload failed, when the client has an answer for it (see supportPortalUpload.ts). */
    code?: string;
    maxBytes?: number;
  }>;

export type CollectLogsResponse =
  | CollectLogsSuccessResponse
  | CollectLogsErrorResponse;

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
