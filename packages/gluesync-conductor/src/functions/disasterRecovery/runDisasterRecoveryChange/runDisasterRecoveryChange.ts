import type { FastifyReply } from 'fastify';

import buildLocalErrorReply from '../../../diagnosis/buildLocalErrorReply';
import describeFailure from '../../../helpers/describeFailure/describeFailure';
import {
  chronosName,
  coreHubName,
} from '../../../helpers/disasterRecovery/disasterRecovery';
import {
  inspectDisasterRecovery,
  prepareDisasterRecoveryChange,
} from '../../../helpers/disasterRecoverySetup/disasterRecoverySetup';
import buildModeUnknownReply from '../../../helpers/orchestrator/buildModeUnknownReply/buildModeUnknownReply';
import type { ActionOutcome } from '../../../helpers/actionGate/actionGate.model';
import deferred from '../../../utils/deferred';
import { getLogger } from '../../../utils/logger';
import { enterContainerAction } from '../../container/doContainersAction/doContainersAction';
import type { DoContainersActionResponse } from '../../container/doContainersAction/doContainersAction.model';
import type { DisasterRecoveryReplyBody } from '../disasterRecovery.model';
import type { RunDisasterRecoveryChange } from './runDisasterRecoveryChange.model';

type Reply = Readonly<{ statusCode: number; body: DisasterRecoveryReplyBody }>;

const SETUP_FAILED = 'Failed to change disaster recovery';

// Seconds a refused caller should wait before asking again: a recreate and the stability window of Core Hub
const RETRY_AFTER_SECONDS = '60';

// The reply travels back through the very Core Hub that is about to be recreated: it must have
// left, and had the time to be forwarded, before that happens
const FLUSH_TIMEOUT_MS = 5000;
const FORWARD_DELAY_MS = 1000;

const delay = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

const forwardDelayMs = (): number => {
  const configured = Number(process.env.CONDUCTOR_DR_RECREATE_DELAY_MS);

  return Number.isFinite(configured) && configured >= 0
    ? configured
    : FORWARD_DELAY_MS;
};

/** Resolves once the reply has been written to the socket, or after a few seconds whatever happens. */
const whenFlushed = (reply: Readonly<FastifyReply>): Promise<void> =>
  new Promise<void>(resolve => {
    const done = (): void => resolve();
    const { raw } = reply;

    setTimeout(done, FLUSH_TIMEOUT_MS).unref();

    if (!raw || raw.writableFinished) {
      setImmediate(done);
      return;
    }

    raw.once('finish', done);
    raw.once('close', done);
  }).then(() => delay(forwardDelayMs()));

const errorReply = (
  statusCode: number,
  error: string,
  details: string,
): Reply => ({ statusCode, body: { success: false, error, details } });

const failureReply = (error: unknown): Reply =>
  buildLocalErrorReply(error, SETUP_FAILED) ??
  errorReply(500, SETUP_FAILED, describeFailure(error));

/**
 * The container action the three changes share: under the lock of the container actions it
 * checks the host, writes the files, answers 202, and only after the answer is out recreates
 * Chronos and Core Hub. The UI reaches the Conductor through Core Hub, so recreating it
 * first would lose the answer. A failed recreate is rolled back and logged: nobody is
 * waiting for it any more.
 */
const runDisasterRecoveryChange: RunDisasterRecoveryChange = async (
  request,
  reply,
  plan,
) => {
  const logger = getLogger();
  const { docker } = request.server;
  // The first answer is the one that counts: after a 202 a later failure is only logged
  const answer = deferred<Reply>();
  const flushed = deferred<undefined>();

  const finished = (
    statusCode: number,
    body: DoContainersActionResponse,
  ): ActionOutcome<DoContainersActionResponse> => ({ statusCode, body });

  const perform = async (): Promise<
    ActionOutcome<DoContainersActionResponse>
  > => {
    try {
      const inspection = await inspectDisasterRecovery(docker);

      if (inspection.dockerUnknown) {
        answer.resolve({ statusCode: 503, body: buildModeUnknownReply() });
        return finished(503, buildModeUnknownReply());
      }

      const refusal = plan.refuse(inspection);

      if (refusal) {
        logger.warn(
          { action: plan.action, reason: refusal.details },
          `[disaster-recovery] refused: ${refusal.error}`,
        );
        answer.resolve(errorReply(409, refusal.error, refusal.details));
        return finished(409, {
          success: false,
          error: refusal.error,
          details: refusal.details,
        });
      }

      const prepared = await prepareDisasterRecoveryChange(
        plan.change,
        inspection.targets,
      );

      answer.resolve({
        statusCode: 202,
        body: { success: true, data: plan.accepted(prepared.restarting) },
      });
      await flushed.promise;
      await prepared.recreate();
    } catch (error) {
      logger.error(
        { error, action: plan.action },
        `[disaster-recovery] ${SETUP_FAILED}`,
      );
      answer.resolve(failureReply(error));
    }

    return finished(200, { success: true, data: { containers: [] } });
  };

  const entry = enterContainerAction(
    { action: plan.action, ids: [coreHubName(), chronosName()] },
    perform,
  );

  if (entry.kind !== 'started') {
    const { running } = entry;

    logger.warn(
      { running, requested: plan.action },
      '[disaster-recovery] refused: a container action is running',
    );
    reply.header('Retry-After', RETRY_AFTER_SECONDS);
    reply.code(409);
    reply.send({
      success: false,
      error: 'Another container action is in progress',
      details: `"${running.action}" started at ${running.since}; try again when it has finished`,
    });
    return;
  }

  const outcome = await answer.promise;

  try {
    reply.code(outcome.statusCode);
    reply.send(outcome.body);
  } catch (error) {
    // The 202 never left: the recreate goes on all the same, the files are written
    flushed.resolve(undefined);
    throw error;
  }

  // The recreate waits for the 202 to be out (a refusal ends the action on its own)
  if (outcome.statusCode === 202) {
    // Fire and forget on purpose: the action above waits on `flushed`, and it must go on even
    // if watching the socket fails, so the chain ends in a handler that logs and resolves
    whenFlushed(reply)
      .then(() => flushed.resolve(undefined))
      .catch((error: unknown) => {
        logger.error(
          { error, action: plan.action },
          '[disaster-recovery] could not tell when the reply was flushed',
        );
        flushed.resolve(undefined);
      });
  }
};

export default runDisasterRecoveryChange;
