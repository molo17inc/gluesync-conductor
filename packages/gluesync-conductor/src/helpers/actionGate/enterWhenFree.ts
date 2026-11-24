import {
  ActionKey,
  ActionOutcome,
  GateEntry,
  RunningAction,
} from './actionGate.model';

type EnterWhenFreeOptions = Readonly<{
  // Said once, the first time the gate is found busy
  onWait?: (running: RunningAction) => void;
  // Pause between two looks at the gate
  pause?: () => Promise<void>;
}>;

const POLL_MS = 1000;

const pollPause = (): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, POLL_MS);
  });

/**
 * Runs `perform` under the action gate, waiting for it when another action
 * holds it. For work that must happen and must not overlap a user action
 * (the startup heals): unlike a request it is never refused or skipped. The
 * gate does not hand out the running action's promise on `busy`, so it is
 * polled.
 */
const enterWhenFree = async <Body>(
  enter: (
    key: ActionKey,
    perform: () => Promise<ActionOutcome<Body>>,
  ) => GateEntry<Body>,
  key: ActionKey,
  perform: () => Promise<ActionOutcome<Body>>,
  { onWait, pause = pollPause }: EnterWhenFreeOptions = {},
): Promise<ActionOutcome<Body>> => {
  const attempt = async (waited: boolean): Promise<ActionOutcome<Body>> => {
    const entry = enter(key, perform);

    if (entry.kind !== 'busy') {
      return entry.outcome;
    }

    if (!waited) {
      onWait?.(entry.running);
    }

    await pause();
    return attempt(true);
  };

  return attempt(false);
};

export default enterWhenFree;
