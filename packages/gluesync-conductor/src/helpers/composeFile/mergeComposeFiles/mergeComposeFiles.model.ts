import { RawComposeService } from '../../../models/composeFile.model';

export type MergeTwoServices = (
  service1?: Partial<RawComposeService>,
  service2?: Partial<RawComposeService>,
) => Partial<RawComposeService>;
