import type { FastifyReply, FastifyRequest } from 'fastify';

import type {
  DisasterRecoveryChange,
  DisasterRecoveryInspection,
} from '../../../helpers/disasterRecoverySetup/disasterRecoverySetup.model';

/** Why the request cannot be carried out in the state the host is in; the reply is a 409. */
export type Refusal = Readonly<{ error: string; details: string }>;

// eslint-disable-next-line functional/no-mixed-types
export type DisasterRecoveryChangePlan = Readonly<{
  /** Names the action in the container action lock and the log. */
  action: 'dr-setup-first' | 'dr-setup-join' | 'dr-disable';
  refuse: (inspection: Readonly<DisasterRecoveryInspection>) => Refusal | null;
  change: DisasterRecoveryChange;
  /** The data of the 202 reply, given the services that restart. */
  accepted: (
    restarting: ReadonlyArray<string>,
  ) => Readonly<Record<string, unknown>>;
}>;

export type RunDisasterRecoveryChange = (
  request: Readonly<FastifyRequest>,
  reply: Readonly<FastifyReply>,
  plan: DisasterRecoveryChangePlan,
) => Promise<void>;
