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
}>;

export interface UpdateNormalBulkResult {
  orderedIds: readonly string[];
  results: PromiseSettledResult<any>[];
  pipelines?: UpdatePipelinesReport;
}

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
}>;

export type UpdateNormalBulk = (
  action: (id: string) => Promise<any>,
  composeJson: RawComposeFile,
  requestIds: readonly string[],
  releaseChannel: ReleaseChannelTypes,
  options?: UpdateNormalBulkOptions,
) => Promise<UpdateNormalBulkResult>;
