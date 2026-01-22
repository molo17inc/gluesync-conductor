import { EnvFile } from '../../models/composeFile.model';

const buildEnvFileConf = (): Readonly<EnvFile> => {
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
