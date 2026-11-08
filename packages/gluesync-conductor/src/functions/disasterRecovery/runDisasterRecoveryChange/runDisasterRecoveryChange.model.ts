import type { FastifyReply, FastifyRequest } from 'fastify';

import type {
  DisasterRecoveryChange,
  DisasterRecoveryInspection,
} from '../../../helpers/disasterRecoverySetup/disasterRecoverySetup.model';

/** Why the request cannot be carried out in the state the host is in; the reply is a 409. */
export type Refusal = Readonly<{ error: string; details: string }>;

/**
 * What a check made under the container action lock found: a `refusal` (a 409, nothing is written), or the `data` that joins the
 * data of the 202 reply.
 */
export type Preflight = Readonly<{
  refusal: Refusal | null;
  data?: Readonly<Record<string, unknown>>;
}>;

// eslint-disable-next-line functional/no-mixed-types
export type DisasterRecoveryChangePlan = Readonly<{
  /** Names the action in the container action lock and the log. */
  action: 'dr-setup-first' | 'dr-setup-join' | 'dr-disable';
  refuse: (inspection: Readonly<DisasterRecoveryInspection>) => Refusal | null;
  /**
   * A check that needs the network, made after `refuse` (so a host that cannot take the change is refused for that, not for the
   * check) and still before anything is written, under the same lock.
   */
  preflight?: () => Promise<Preflight>;
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
