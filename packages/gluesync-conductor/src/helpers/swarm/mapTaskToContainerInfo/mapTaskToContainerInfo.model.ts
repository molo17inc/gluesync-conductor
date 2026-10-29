import {
  ContainerInfo,
  SwarmContainerInfo,
} from '../../../models/dockerode.model';
import { SwarmService, SwarmTask } from '../swarm.model';

export type MapTaskToContainerInfoInput = Readonly<{
  service: SwarmService;
  // The task to describe: the newest running one, else the newest
  task: SwarmTask;
  // Tasks of the service that are running now
  runningTasks: number;
  // Tasks of the service that should be running (the count a global service
  // wants, as it has no replica number)
  wantedTasks: number;
}>;

export type MapTaskToContainerInfo = (
  input: MapTaskToContainerInfoInput,
) => ContainerInfo & Readonly<{ swarm: SwarmContainerInfo }>;
