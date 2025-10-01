import {
  ComposeDependsOn,
  ComposePort,
  ComposeVolume,
  RawComposeFile,
  RawComposeService,
} from '../../models/composeFile.model';
import { ConductorServiceTypes } from '../../models/conductor.model';
import { ValidationResult } from '../agentValidation/agentValdiation.model';

export type Agent = Readonly<{
  id: string;
  serviceId?: string;
  imageName: string;
  type: 'target' | 'source';
  nickname?: string;
  /**
   * Contains the same core-hub version tag.
   */
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
  dependsOn: ComposeDependsOn;
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
  type: ConductorServiceTypes,
  composeJson: Partial<RawComposeFile>,
  agents: ReadonlyArray<Agent>,
  validate: (
    agent: Agent,
    serviceId: string,
    services?: Record<string, any>,
  ) => ValidationResult,
  createService: (agent: Agent) => RawComposeService,
) => Promise<{
  results: AgentResultItem[];
  updatedComposeJson: RawComposeFile;
}>;
