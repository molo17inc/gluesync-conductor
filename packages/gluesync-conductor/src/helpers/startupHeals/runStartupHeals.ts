import {
  ActionKey,
  ActionOutcome,
  GateEntry,
  RunningAction,
} from '../actionGate/actionGate.model';
import enterWhenFree from '../actionGate/enterWhenFree';

/** The action key the startup compose work holds the gate under. */
export const STARTUP_HEAL_ACTION = 'startup-heal';

type RunStartupHeals<Body> = Readonly<{
  enter: (
    key: ActionKey,
    perform: () => Promise<ActionOutcome<Body>>,
  ) => GateEntry<Body>;
  // What the gate's outcome carries: nothing reads it, but the gate is typed
  idleBody: () => Body;
  onWait?: (running: RunningAction) => void;
  pause?: () => Promise<void>;
}>;

/**
 * Compose startup work that rewrites the compose file and recreates services
 * (adoption, the proxy and Courier heals) runs as a container action of its
 * own. The server already listens, and a user's update recreating the same Core
 * Hub meanwhile gave "container name already in use" and lost compose writes
 * (each side rewrites the whole file from its own snapshot, GS-1485). A request
 * that comes meanwhile is refused as busy; if an action already runs, the
 * startup waits for it and then runs, it is never skipped. The gate lets go
 * when the work ends, however it ends.
 */
const runStartupHeals = async <Body>(
  // In order; each handles its own failures (runStartupStep), so one failing
  // does not stop the next
  steps: ReadonlyArray<() => Promise<void>>,
  { enter, idleBody, onWait, pause }: RunStartupHeals<Body>,
): Promise<void> => {
  await enterWhenFree(
    enter,
    { action: STARTUP_HEAL_ACTION, ids: [] },
    async () => {
      await steps.reduce(
        (previous, step) => previous.then(step),
        Promise.resolve(),
      );
      return { statusCode: 200, body: idleBody() };
    },
    { onWait, pause },
  );
};

export default runStartupHeals;
