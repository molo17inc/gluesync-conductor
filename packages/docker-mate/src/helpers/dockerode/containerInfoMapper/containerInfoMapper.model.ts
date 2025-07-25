import { ContainerInfo as DkrContainerInfo } from 'dockerode';

import { ContainerInfo } from '../../../models/dockerode.model';

export type ContainerInfoMapper = (
  container?: DkrContainerInfo,
) => ContainerInfo | undefined;
