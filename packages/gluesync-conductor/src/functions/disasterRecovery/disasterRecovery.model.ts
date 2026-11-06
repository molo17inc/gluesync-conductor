import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ErrorResponse, SuccessResponse } from '../../models/common.model';
import type { FirstSiteRequest } from '../../helpers/disasterRecoveryPairing/disasterRecoveryPairing.model';

export type DisasterRecoveryReplyBody =
  | SuccessResponse<Record<string, unknown>>
  | ErrorResponse;

export type FirstSiteBody = FirstSiteRequest;

export type JoinBody = Readonly<{
  pairingCode: string;
  confirmDataMovedAside: true;
}>;

export type DisableBody = Readonly<{ confirm: true }>;

export type DisasterRecoveryHandler = (
  request: Readonly<FastifyRequest>,
  reply: Readonly<FastifyReply>,
) => Promise<void>;
