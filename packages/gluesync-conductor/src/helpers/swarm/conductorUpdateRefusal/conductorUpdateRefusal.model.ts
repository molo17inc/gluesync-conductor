/**
 * Why a swarm-mode Conductor must not update itself from `running` to
 * `target`, or `null` when it may. The Conductor GA of the day has no Swarm
 * support: a Swarm Conductor that moved to it would come back compose-only and
 * start editing and recreating the stack. So the target has to be greater, by
 * semver, than the running version, and the running version has to be a
 * release (a dev build such as `swarm-dev` is not).
 *
 * A target equal to the running version is not refused: there is no update.
 * Compose mode never calls this.
 */
export type ConductorUpdateRefusal = (
  running: string | null | undefined,
  target: string | null | undefined,
) => string | null;
