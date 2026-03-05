import { FastifyInstance } from 'fastify';
import { ReleaseChannelTypes } from '../../../../models/conductor.model';

export type MigrationWithUpdate = (
  requestIds: readonly string[],
  releaseChannel: ReleaseChannelTypes,
  isWindows: boolean,
  helperImageWindows: string,
  docker: Readonly<FastifyInstance['docker']>,
) => Promise<void>;
