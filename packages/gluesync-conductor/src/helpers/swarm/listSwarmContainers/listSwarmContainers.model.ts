import type Docker from 'dockerode';

import { ListContainerItem } from '../../../functions/container/listContainers/listContainers.model';
import { ComposeFile } from '../../../models/composeFile.model';

export type ListSwarmContainers = (
  docker: Readonly<Docker>,
  namespace: string,
  composeJson: Readonly<Partial<ComposeFile>>,
) => Promise<ReadonlyArray<ListContainerItem>>;
