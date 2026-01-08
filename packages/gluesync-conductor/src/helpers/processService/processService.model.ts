import { Require } from '../../models/common.model';
import {
  ComposeDependsOn,
  ComposePort,
  ComposeVolume,
  RawComposeFile,
  RawComposeService,
} from '../../models/composeFile.model';
import { ConductorServiceTypes } from '../../models/conductor.model';
import { ValidationResult } from '../serviceValidation/serviceValdiation.model';

export type Service = Readonly<{
  id: string;
  serviceId?: string;
  imageName: string;
  type: ConductorServiceTypes;
  agentType?: 'target' | 'source';
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

export type ServiceResultItem =
  | {
      success: true;
      serviceId: string;
      service: RawComposeService;
    }
  | { success: false; serviceId: string; error: string };

export type CreateServiceError = (
  message: string,
  status: number,
  serviceId: string,
) => Error & { status: number; serviceId: string; error: string };

export type ProcessServices = (
  composeJson: Partial<RawComposeFile>,
  services: ReadonlyArray<Service>,
  validate: (
    service: Service,
    serviceId: string,
    services?: Record<string, any>,
  ) => ValidationResult,
  createService: (service: Require<Service, 'serviceId'>) => RawComposeService,
) => Promise<{
  results: ServiceResultItem[];
  updatedComposeJson: RawComposeFile;
}>;
