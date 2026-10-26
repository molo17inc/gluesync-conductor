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

export type ComposeUpdateConfig = Readonly<{
  parallelism?: number;
  delay?: string;
  failure_action?: 'continue' | 'pause' | 'rollback';
  monitor?: string;
  max_failure_ratio?: number;
  order?: 'stop-first' | 'start-first';
}>;

export type ComposeServiceDeploy = Readonly<{
  mode?: 'replicated' | 'global' | 'replicated-job' | 'global-job';
  replicas?: number;
  labels?: ReadonlyArray<string> | Record<string, any>;
  placement?: Readonly<{
    constraints?: ReadonlyArray<string>;
    preferences?: ReadonlyArray<Record<string, any>>;
    max_replicas_per_node?: number;
  }>;
  restart_policy?: Readonly<{
    condition?: 'none' | 'on-failure' | 'any';
    delay?: string;
    max_attempts?: number;
    window?: string;
  }>;
  update_config?: ComposeUpdateConfig;
  rollback_config?: ComposeUpdateConfig;
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

// Long syntax of a volume / port entry (`volumes:` / `ports:` as objects).
// Stack files deployed to Swarm commonly use it.
export type LongVolume = Readonly<{
  type?: 'volume' | 'bind' | 'tmpfs' | 'npipe' | 'cluster';
  source?: string;
  target: string;
  read_only?: boolean;
  [option: string]: unknown;
}>;

export type LongPort = Readonly<{
  target: number | string;
  published?: number | string;
  protocol?: string;
  mode?: 'host' | 'ingress';
  [option: string]: unknown;
}>;

export type EnvFileElement = string | { path: string; required?: boolean };

export type EnvFile = EnvFileElement | ReadonlyArray<EnvFileElement>;

export type Sysctls = ReadonlyArray<string>;

export type Ulimits = Readonly<{
  nofile?: Readonly<{
    soft?: number | null;
    hard?: number | null;
  }>;
}>;

// Common service: allow string or list (raw shape)
export type CommonComposeService = Readonly<{
  image: string;
  container_name?: string;
  restart?: string;
  deploy?: ComposeServiceDeploy;
  depends_on?: ComposeDependsOn;
  healthcheck?: ComposeHealthcheck;
  networks?: ReadonlyArray<string>;
  env_file?: EnvFile; // <-- changed (remove Readonly<EnvFile>)
  sysctls?: Sysctls;
  ulimits?: Ulimits;
}>;

export type RawComposeService = Readonly<
  CommonComposeService &
    Partial<
      Record<
        Extract<ComposeServiceFieldName, 'volumes' | 'ports'>,
        ReadonlyArray<string | LongVolume | LongPort>
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
      environment?: Record<
        string,
        string | number | boolean | null | undefined
      >;
      env_file?: EnvFile;
      sysctls?: Sysctls;
      ulimits?: Ulimits;
    }>
>;

export type ComposeFile = Readonly<
  CommonComposeFile & {
    services?: Record<string, ComposeService>;
    [key: string]: any;
  }
>;
