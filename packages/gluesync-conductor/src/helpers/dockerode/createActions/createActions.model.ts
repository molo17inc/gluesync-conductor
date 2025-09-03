import { FastifyInstance } from 'fastify';
import { IDockerComposeOptions, IDockerComposeResult } from 'docker-compose';
import { ContainerActions } from '../../../models/conductor.model';

export type ContainerAction = (id: string) => Promise<string>;

export type CreateActionsOptions = Readonly<{
  docker: Readonly<FastifyInstance['docker']>;
  filename?: string;
}>;

export type CreateActions = (
  options: CreateActionsOptions,
) => Record<ContainerActions, ContainerAction>;

export type RunCmdFn = (
  options: Readonly<IDockerComposeOptions>,
) => Promise<IDockerComposeResult>;

export type RunCmd = (
  cmdFn: RunCmdFn,
  id: string,
  filename: string,
  extraOptions?: ReadonlyArray<string>,
) => Promise<string>;
