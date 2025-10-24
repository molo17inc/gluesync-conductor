import { GetSystemInfo } from './getSystemInfo.model';

const getSystemInfo: GetSystemInfo = async (docker, log) => {
  const dockerInfo = (await docker.info()) || {};

  log.debug(
    `System info - CPUs: ${dockerInfo.ncpu}, Memory: ${dockerInfo.memTotal} bytes`,
  );

  return {
    ncpu: dockerInfo.NCPU ?? undefined,
    memTotal: dockerInfo.MemTotal ?? undefined,
  };
};

export default getSystemInfo;
