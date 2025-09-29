import { ComposeService } from '../../models/composeFile.model';
import { AgentResultItem } from '../processAgent/processAgent.model';

export type AgentResultWithParsedService =
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
  results: ReadonlyArray<AgentResultItem>,
) => Promise<ReadonlyArray<AgentResultWithParsedService>>;
