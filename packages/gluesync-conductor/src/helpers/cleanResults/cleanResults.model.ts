import { ComposeService } from '../../models/composeFile.model';
import { ServiceResultItem } from '../processService/processService.model';

export type ServiceResultWithParsedService =
  | {
      success: true;
      serviceId: string;
      service?: ComposeService;
    }
  | {
      success: false;
      serviceId: string;
      error: string;
    };

export type CleanResults = (
  results: ReadonlyArray<ServiceResultItem>,
) => Promise<ReadonlyArray<ServiceResultWithParsedService>>;
