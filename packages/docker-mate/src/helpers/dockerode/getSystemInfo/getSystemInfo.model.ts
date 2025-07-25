import { FastifyInstance } from 'fastify';

import { SystemInfo } from '../../../models/dockerode.model';

export type GetSystemInfo = (
  docker: FastifyInstance['docker'],
  logger: FastifyInstance['log'],
) => Promise<SystemInfo>;
