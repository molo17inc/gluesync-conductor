export type AutoReboot = (
  options: Readonly<{
    hostProjectDir: string;
    serviceName: string;
    helperImage: string;
    log: (msg: Readonly<string>) => void;
    isPodman?: boolean;
  }>,
) => Promise<boolean>;
