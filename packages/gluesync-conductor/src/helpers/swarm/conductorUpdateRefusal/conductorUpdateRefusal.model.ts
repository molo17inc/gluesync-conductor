/**
 * Why a swarm-mode Conductor must not update itself from `running` to
 * `target`, or `null` when it may. The Conductor GA of the day has no Swarm
 * support: a Swarm Conductor that moved to it would come back compose-only and
 * start editing and recreating the stack. So the target has to be greater, by
 * semver, than the running version, and the running version has to be a
 * release (a dev build such as `swarm-dev` is not).
 *
 * An alpha build `X.Y.Z.<commit>` counts as a prerelease of X.Y.Z, so the
 * release channels can be switched: alpha 0.14.0.<commit> moves to beta or GA
 * 0.14.0 and to alpha 0.15.0.<commit>, beta 0.14.0 does not move back to alpha
 * 0.14.0.<commit>. Two alpha builds of the same X.Y.Z are refused: their
 * commits do not say which one is newer.
 *
 * A target equal to the running version is not refused: there is no update.
 * Compose mode never calls this.
 */
export type ConductorUpdateRefusal = (
  running: string | null | undefined,
  target: string | null | undefined,
) => string | null;
