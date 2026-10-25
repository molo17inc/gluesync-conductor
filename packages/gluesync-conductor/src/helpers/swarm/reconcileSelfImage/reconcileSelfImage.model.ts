import type Docker from 'dockerode';

import { SwarmOrchestrator } from '../../orchestrator/getOrchestrator/getOrchestrator.model';

export type ReconcileSelfImageOutcome =
  // The stack file now names the image the service is back on
  | 'reconciled'
  | 'in-sync'
  | 'no-rollback'
  // Nothing was safe to change (no service, no image, a variable, a failure)
  | 'skipped';

export type ReconcileSelfImage = (
  docker: Readonly<Docker>,
  orchestrator: Readonly<SwarmOrchestrator>,
) => Promise<ReconcileSelfImageOutcome>;
