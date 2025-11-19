export type AutoUpdate = (
  options: Readonly<{
    hostProjectDir: string;
    serviceName: string;
    helperImage: string;
    log: (msg: Readonly<string>) => void;
  }>,
) => Promise<boolean>;
