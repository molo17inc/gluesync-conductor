import type Docker from 'dockerode';

import { WaitForServiceConvergedOptions } from '../waitForServiceConverged/waitForServiceConverged.model';

export type RestoreUpdateConfigOutcome =
  // The stashed UpdateConfig is back and the label gone
  | 'restored'
  // Nothing stashed: no update by Conductor, or already restored
  | 'nothing-stashed';

export type RestoreUpdateConfig = (
  docker: Readonly<Docker>,
  fullName: string,
) => Promise<RestoreUpdateConfigOutcome>;

export type RestoreSelfUpdateConfigOutcome =
  | RestoreUpdateConfigOutcome
  // The update did not converge (Swarm rolled it back, or it stalled):
  // Swarm's rollback restores the previous spec, label and UpdateConfig alike
  | 'not-converged'
  | 'failed';

export type RestoreSelfUpdateConfig = (
  docker: Readonly<Docker>,
  fullName: string,
  options?: WaitForServiceConvergedOptions,
) => Promise<RestoreSelfUpdateConfigOutcome>;
