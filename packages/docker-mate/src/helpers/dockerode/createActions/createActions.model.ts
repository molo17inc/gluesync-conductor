import { FastifyInstance } from 'fastify';
import { ContainerActions } from '../../../models/conductor.model';
import { IDockerComposeResult } from 'docker-compose';

export type ContainerAction = (id: string) => Promise<string>;

export type CreateActionsOptions = Readonly<{
  docker: Readonly<FastifyInstance['docker']>;
  filename?: string;
}>;

export type CreateActions = (
  options: CreateActionsOptions,
) => Record<ContainerActions, ContainerAction>;

export type DockerComposeCmd = (
  options: Readonly<{
    cwd: string;
    config: string;
    log: boolean;
    commandOptions?: string[];
  }>,
) => Promise<IDockerComposeResult>;
