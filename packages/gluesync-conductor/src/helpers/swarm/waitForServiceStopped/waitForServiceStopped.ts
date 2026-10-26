import { getLogger } from '../../../utils/logger';
import getServiceTasks from '../getServiceTasks/getServiceTasks';
import { WaitForServiceStopped } from './waitForServiceStopped.model';

const sleepMs = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

/**
 * After scaling to zero the tasks are asked to shut down and take their stop
 * grace period to do so: the service is stopped when none of them is still
 * running, whatever their desired state.
 */
const waitForServiceStopped: WaitForServiceStopped = async (
  docker,
  fullName,
  { maxWaitMs = 60_000, pollMs = 1000, sleep = sleepMs, now = Date.now } = {},
) => {
  const started = now();

  const poll = async (): Promise<ReturnType<WaitForServiceStopped>> => {
    const running = (
      await getServiceTasks(docker, fullName, {
        includeStopped: true,
        resolveNodes: false,
      })
    ).filter(task => task.state === 'running').length;

    if (running === 0) {
      getLogger().info({ service: fullName }, '[swarm] service stopped');

      return { ok: true };
    }

    if (now() - started >= maxWaitMs) {
      return {
        ok: false,
        reason: `${fullName} still has ${running} running task(s) after ${Math.round(maxWaitMs / 1000)}s`,
      };
    }

    await sleep(pollMs);

    return poll();
  };

  return poll();
};

export default waitForServiceStopped;
