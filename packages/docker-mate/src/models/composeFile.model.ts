export type ComposeService = Readonly<{
  image?: string;
  container_name?: string;
  restart?: string;
  environment?: ReadonlyArray<string>;
  ports?: ReadonlyArray<string>;
  volumes?: ReadonlyArray<string>;
}>;

export type ComposeFile = Readonly<{
  name?: string;
  services?: Record<string, ComposeService>;
}>;
