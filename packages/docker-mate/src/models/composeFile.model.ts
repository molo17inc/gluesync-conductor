export enum LabelPrefix {
  CONDUCTOR = 'com.molo17.conductor',
  COMPOSE = 'com.docker.compose',
}

export type ComposeServiceFieldConfig = {
  separator: string;
};

export const composeServiceFieldConfig = {
  environment: { separator: '=' },
  labels: { separator: '=' },
  ports: { separator: ':' },
  expose: { separator: ':' },
  volumes: { separator: ':' },
} satisfies Record<string, ComposeServiceFieldConfig>;

export type ComposeServiceFieldName = keyof typeof composeServiceFieldConfig;

export type RawComposeService = Readonly<{
  image: string;
  container_name: string;
  restart?: string;
}> &
  Partial<Record<ComposeServiceFieldName, ReadonlyArray<string>>>;

export type RawComposeFile = {
  name?: string;
  services?: Record<string, RawComposeService>;
  [key: string]: any;
};
