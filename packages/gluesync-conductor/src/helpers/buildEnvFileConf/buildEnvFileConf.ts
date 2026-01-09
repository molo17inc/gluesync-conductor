const buildEnvFileConf = (): ReadonlyArray<
  | string
  | {
      path: string;
      required?: boolean;
      format?: string;
    }
> => {
  const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true' || false;

  const fallbackAbsEnvPath = isWindows
    ? 'C:\\opt\\gluesync-conductor\\root-folder\\.env'
    : '/opt/gluesync-conductor/root-folder/.env';

  return [
    { path: '.env', required: false },
    { path: fallbackAbsEnvPath, required: false },
  ];
};

export default buildEnvFileConf;
