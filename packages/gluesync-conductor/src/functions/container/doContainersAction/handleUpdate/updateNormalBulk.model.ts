import type Docker from 'dockerode';
import { RawComposeFile } from '../../../../models/composeFile.model';
import { ReleaseChannelTypes } from '../../../../models/conductor.model';
import {
  NotResumed,
  PipelineMaintenance,
} from '../../../../helpers/pipelineMaintenance/pipelineMaintenance.model';

// What happened to the pipelines of an update that included Core Hub
export type UpdatePipelinesReport = Readonly<{
  // The Core Hub service: the reply item these belong to
  service: string;
  paused: ReadonlyArray<string>;
  resumed: ReadonlyArray<string>;
  notResumed: ReadonlyArray<NotResumed>;
  alreadyInMaintenance: ReadonlyArray<string>;
  notPausedReason?: string;
  // Left on disk for the restarted Conductor (Core Hub on Windows): this one
  // cannot reach the new Core Hub
  resumeAfterRestart?: boolean;
}>;

export interface UpdateNormalBulkResult {
  orderedIds: readonly string[];
  results: PromiseSettledResult<any>[];
  pipelines?: UpdatePipelinesReport;
}

// eslint-disable-next-line functional/no-mixed-types -- options: values and the restart check
export type UpdateNormalBulkOptions = Readonly<{
  // The update action already put a failed service back on Swarm: only the
  // stack file has to follow
  swarm?: boolean;
  // The stack the services belong to (Swarm only): lets a rollback restore the
  // services through the Swarm API
  namespace?: string;
  // Where the containers are looked at (before the update and when rolling
  // back on compose); without it a rollback only restores the compose file
  docker?: Readonly<Docker>;
  // When the update includes Core Hub: the running pipelines go into
  // maintenance mode before any image changes and come back once Core Hub is
  // stable again (or rolled back)
  pipelineMaintenance?: PipelineMaintenance;
  // True once the update asked for this Conductor to restart after the reply
  // (Core Hub on Windows): the paused pipelines are then resumed by the
  // restarted Conductor, which reads them from disk
  conductorRestarts?: () => boolean;
}>;

export type UpdateNormalBulk = (
  action: (id: string) => Promise<any>,
  composeJson: RawComposeFile,
  requestIds: readonly string[],
  releaseChannel: ReleaseChannelTypes,
  options?: UpdateNormalBulkOptions,
) => Promise<UpdateNormalBulkResult>;
