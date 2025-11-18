export type RunSelfUpdateOptions = {
  hostProjectDir: string;
  serviceName: string;
  helperImage: string;
  log: (msg: string) => void;
};

export type RunSelfUpdate = (options: Readonly<RunSelfUpdateOptions>) => void;
