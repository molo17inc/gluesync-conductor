import { FastifyInstance } from 'fastify';
import { ContainerActions } from '../../../models/conductor.model';

export type ContainerAction = (id: string) => Promise<string>;

export type CreateActionsOptions = Readonly<{
  docker: Readonly<FastifyInstance['docker']>;
  filename?: string;
}>;

export type CreateActions = (
  options: CreateActionsOptions,
) => Record<ContainerActions, ContainerAction>;
