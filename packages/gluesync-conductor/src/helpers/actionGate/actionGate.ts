import { ActionGate, ActionOutcome, RunningAction } from './actionGate.model';

// One container action at a time. Two updates running together (double click,
// two tabs, UI plus Chronos) recreated the same containers concurrently and
// failed with "container name already in use", and self-updated twice.
//
// A request for the same action on the same ids while it runs is the same
// intent arriving again, typically a retry after the first request lost its
// connection (updating the reverse proxy cuts the UI's own request through
// it). It joins the running action and gets its result instead of a refusal.

const sameIds = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
  a.length === b.length &&
  [...a].sort().every((id, index) => id === [...b].sort()[index]);

const createActionGate = <Body>(
  options?: Readonly<{ onThrow: (error: unknown) => ActionOutcome<Body> }>,
): ActionGate<Body> => {
  const state = new Map<
    'current',
    RunningAction & Readonly<{ outcome: Promise<ActionOutcome<Body>> }>
  >();

  return {
    current: () => {
      const running = state.get('current');
      return running
        ? { action: running.action, ids: running.ids, since: running.since }
        : undefined;
    },
    enter: (key, perform) => {
      const running = state.get('current');
      if (running) {
        const info: RunningAction = {
          action: running.action,
          ids: running.ids,
          since: running.since,
        };
        return running.action === key.action && sameIds(running.ids, key.ids)
          ? { kind: 'joined', running: info, outcome: running.outcome }
          : { kind: 'busy', running: info };
      }

      const outcome = perform()
        .catch((error: unknown): ActionOutcome<Body> => {
          if (options?.onThrow) {
            return options.onThrow(error);
          }
          throw error;
        })
        .finally(() => {
          state.delete('current');
        });
      state.set('current', {
        action: key.action,
        ids: key.ids,
        since: new Date().toISOString(),
        outcome,
      });
      return { kind: 'started', outcome };
    },
  };
};

export default createActionGate;
