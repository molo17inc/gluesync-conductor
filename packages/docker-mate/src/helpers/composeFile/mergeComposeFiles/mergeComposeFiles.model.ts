import { ComposeService } from '../../../models/composeFile.model';

export type MergeTwoServices = (
  service1?: Partial<ComposeService>,
  service2?: Partial<ComposeService>,
) => Partial<ComposeService>;
