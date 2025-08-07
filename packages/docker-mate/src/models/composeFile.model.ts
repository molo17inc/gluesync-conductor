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
      cpus?: number;
      memory?: string;
    };
    limits?: {
      cpus?: number;
      memory?: string;
    };
  };
}>;

export type CommonComposeService = Readonly<{
  image: string;
  container_name: string;
  restart?: string;
  deploy?: ComposeServiceDeploy;
}>;

export type RawComposeService = Readonly<
  CommonComposeService &
    Partial<Record<ComposeServiceFieldName, ReadonlyArray<string>>>
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
