// A Core Hub recreated on Windows gets a new address that this Conductor does
// not see until it restarts (Windows NAT keeps the old DNS answer). The update
// asks for that restart here; the update handler performs it once the whole
// update (stability check, rollback, the steps after it) is done and the reply
// has gone out. One container action runs at a time, so one flag is enough.
const pending = new Set<'restart'>();

export const requestConductorRestart = (): void => {
  pending.add('restart');
};

export const conductorRestartRequested = (): boolean => pending.has('restart');

/** Whether a restart was asked for; clears the request. */
export const takeConductorRestart = (): boolean => pending.delete('restart');
