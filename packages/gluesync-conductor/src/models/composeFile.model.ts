export enum LabelPrefix {
  CONDUCTOR = 'com.molo17.conductor',
  COMPOSE = 'com.docker.compose',
}

export type ComposeServiceFieldConfig = Readonly<{
  separator: string;
}>;

export const composeServiceFieldConfig = {
  environment: { separator: '=' },
  labels: { separator: '=' },
  ports: { separator: ':' },
  // expose: { separator: ':' },
  volumes: { separator: ':' },
} satisfies Record<string, ComposeServiceFieldConfig>;

export type ComposeServiceFieldName = keyof typeof composeServiceFieldConfig;

export type CommonComposeFile = Readonly<{
  name?: string;
}>;

export type ComposeServiceDeploy = Readonly<{
  resources?: {
    reservations?: {
      cpus?: number | null;
      memory?: string | null;
    };
    limits?: {
      cpus?: number | null;
      memory?: string | null;
    };
  };
}>;

export type ComposeDependsOn =
  | string[] // Simple: ['service1', 'service2']
  | {
      [serviceName: string]: {
        condition:
          | 'service_started'
          | 'service_healthy'
          | 'service_completed_successfully';
      };
    }[];

export interface ComposeHealthcheck {
  test: string | string[]; // Command to run (string for CMD-SHELL, array for CMD)
  interval?: string; // e.g., '30s'
  timeout?: string; // e.g., '10s'
  retries?: number; // e.g., 3
  start_period?: string; // e.g., '20s' (grace period)
  disable?: boolean; // If true, disables healthcheck
}

export type CommonComposeService = Readonly<{
  image: string;
  container_name: string;
  restart?: string;
  deploy?: ComposeServiceDeploy;
  depends_on?: ComposeDependsOn;
  healthcheck?: ComposeHealthcheck;
}>;

export type RawComposeService = Readonly<
  CommonComposeService &
    Partial<
      Record<
        Extract<ComposeServiceFieldName, 'volumes' | 'ports'>,
        ReadonlyArray<string>
      > &
        Record<
          Extract<ComposeServiceFieldName, 'environment' | 'labels'>,
          ReadonlyArray<string> | Record<string, any>
        >
    >
>;

export type RawComposeFile = Readonly<
  CommonComposeFile & {
    services?: Record<string, RawComposeService>;
    [key: string]: any;
  }
>;

export type ComposeVolume = Readonly<{
  type?: string;
  host: string;
  container: string;
  mode?: 'rw' | 'ro';
}>;

export type ComposePort = Readonly<{
  host: string | number;
  container: string | number;
  protocol?: 'tcp' | 'udp';
}>;

export type ComposeService = Readonly<
  CommonComposeService &
    Readonly<{
      labels?: Record<string, string | number | boolean | null | undefined>;
      volumes?: ReadonlyArray<ComposeVolume>;
      ports?: ReadonlyArray<ComposePort>;
    }>
>;

export type ComposeFile = Readonly<
  CommonComposeFile & {
    services?: Record<string, ComposeService>;
    [key: string]: any;
  }
>;
