import { ContainerActions } from '../../../models/conductor.model';
import { SwarmOrchestrator } from '../../orchestrator/getOrchestrator/getOrchestrator.model';
import { CreateActionsOptions } from '../../dockerode/createActions/createActions.model';

export type SwarmAction = (id: string) => Promise<string>;

// `removeNetwork` is the same as in compose mode: networks are not services
export type SwarmContainerActions = Record<
  Exclude<ContainerActions, 'removeNetwork'>,
  SwarmAction
>;

export type CreateSwarmActionsOptions = Readonly<{
  docker: CreateActionsOptions['docker'];
  orchestrator: SwarmOrchestrator;
  // The stack file: the compose file the helpers read and write
  filename: string;
}>;

export type CreateSwarmActions = (
  options: CreateSwarmActionsOptions,
) => SwarmContainerActions;
