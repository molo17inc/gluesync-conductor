export type ComposeService = Readonly<{
  image?: string;
  container_name?: string;
  restart?: string;
  environment?: ReadonlyArray<string>;
  ports?: ReadonlyArray<string>;
  volumes?: ReadonlyArray<string>;
  labels?: ReadonlyArray<string>;
}>;

export type ComposeFile = {
  name?: string;
  services?: Record<string, ComposeService>;
  [key: string]: any;
};
