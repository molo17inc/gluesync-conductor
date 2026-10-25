import { getLogger } from '../../../utils/logger';
import { getDecidedOrchestrator } from '../getOrchestrator/getOrchestrator';
import { AwaitDecidedOrchestrator } from './awaitDecidedOrchestrator.model';

const sleepMs = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

/**
 * At startup Docker can still be coming up. Startup healing edits the compose
 * file and recreates containers, which is only right in compose mode, so it
 * waits (bounded) until the mode is known instead of assuming one.
 */
const awaitDecidedOrchestrator: AwaitDecidedOrchestrator = async (
  docker,
  {
    maxWaitMs = 60_000,
    initialDelayMs = 1000,
    maxDelayMs = 8000,
    sleep = sleepMs,
    now = Date.now,
  } = {},
) => {
  const started = now();

  const attempt = async (
    delayMs: number,
  ): Promise<Awaited<ReturnType<AwaitDecidedOrchestrator>>> => {
    const orchestrator = await getDecidedOrchestrator(docker);

    if (orchestrator) {
      return orchestrator;
    }

    const waited = now() - started;

    if (waited >= maxWaitMs) {
      return undefined;
    }

    getLogger().warn(
      { waitedMs: waited },
      '[orchestrator] Docker not answering yet, retrying detection',
    );

    await sleep(Math.min(delayMs, maxWaitMs - waited));

    return attempt(Math.min(delayMs * 2, maxDelayMs));
  };

  return attempt(initialDelayMs);
};

export default awaitDecidedOrchestrator;
