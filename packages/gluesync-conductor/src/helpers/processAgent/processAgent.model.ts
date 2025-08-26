import {
  ComposePort,
  ComposeVolume,
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
