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

export type ComposeService = Readonly<{
  image: string;
  container_name: string;
  restart?: string;
}> &
  Partial<Record<ComposeServiceFieldName, ReadonlyArray<string>>>;

export type ComposeFile = {
  name?: string;
  services?: Record<string, ComposeService>;
  [key: string]: any;
};
