import type Docker from 'dockerode';

import { SwarmService } from '../swarm.model';

export type MapService = (service: Readonly<Docker.Service>) => SwarmService;
