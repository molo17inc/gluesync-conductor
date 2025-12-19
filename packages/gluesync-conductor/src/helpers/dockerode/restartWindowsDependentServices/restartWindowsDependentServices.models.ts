import type Dockerode from 'dockerode';
import { RunCmd } from '../createActions/createActions.model';

export type RestartWindowsDependentServices = {
  docker: Dockerode;
  runCmd: RunCmd;
  filename: string;
  coreHubServiceId: string;
  chronosService: string;
  conductorService: string;
};
