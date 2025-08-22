import { FastifyInstance } from 'fastify';

import { SystemInfo } from '../../../models/dockerode.model';

export type GetSystemInfo = (
  docker: Readonly<FastifyInstance['docker']>,
  logger: Readonly<FastifyInstance['log']>,
) => Promise<SystemInfo>;
