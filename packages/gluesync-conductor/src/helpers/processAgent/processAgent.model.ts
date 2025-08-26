import {
  ComposePort,
  ComposeVolume,
  RawComposeFile,
  RawComposeService,
} from '../../models/composeFile.model';

export type Agent = Readonly<{
  imageName: string;
  type: 'target' | 'source';
  nickname?: string;
  tag?: string;
  environment?: Record<string, any>;
  labels: Record<string, any>;
  ports?: ReadonlyArray<ComposePort>;
  volumes?: ReadonlyArray<ComposeVolume>;
  reservations?: {
    cpus?: number | null;
    memory?: string | null;
  };
  limits?: {
    cpus?: number | null;
    memory?: string | null;
  };
}>;

export type AgentResultItem =
  | {
      success: true;
      serviceId: string;
      service: RawComposeService;
    }
  | { success: false; serviceId: string; error: string };

export type CreateAgentError = (
  message: string,
  status: number,
  serviceId: string,
) => Error & { status: number; serviceId: string; error: string };

export type ProcessAgents = (
  agents: ReadonlyArray<Agent>,
  validateExistence: (existingService: any) => boolean,
  createService: (agent: Agent) => RawComposeService,
  existErrorMsg: string,
  typeErrorMsg: string,
) => Promise<{
  results: AgentResultItem[];
  updatedComposeJson: RawComposeFile;
}>;
