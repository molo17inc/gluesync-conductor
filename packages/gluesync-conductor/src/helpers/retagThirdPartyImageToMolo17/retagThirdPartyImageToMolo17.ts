import fetchAgentInfo from '../agentInfo/agentInfo';
import { isImageNotPublished } from '../agentInfo/agentInfo.errors';
import parseImage from '../parseImage/parseImage';
import getVersionByChannel from '../releaseChannel/getVersionByChannel';

export const toThirdPartyRepo = (image: string): string | null => {
  const lower = (image || '').toLowerCase();

  // use substring match exactly as requested
  if (lower === 'traefik') {
    return 'traefik';
  }
  if (lower === 'prom/prometheus') {
    return 'prometheus';
  }
  if (lower === 'grafana/grafana') {
    return 'grafana';
  }
  if (lower === 'portainer/portainer-ce') {
    return 'portainer';
  }

  return null;
};

export const isMolo17Image = (image: string, repo: string): boolean => {
  // accept "molo17/image"
  const lower = (image || '').toLowerCase();
  return lower.startsWith(`molo17/${repo}`);
};

export const retagThirdPartyImageToMolo17GA = async (
  image: string,
  isWindows: boolean,
  windowsYear?: string,
): Promise<string | null> => {
  const parsedImage = parseImage(image);

  // already molo17/<repo>:<tag> -> do nothing
  if (isMolo17Image(image, parsedImage.fullName)) {
    return null;
  }

  const repo = toThirdPartyRepo(parsedImage.fullName);
  if (!repo || (isWindows && !windowsYear)) {
    return null;
  }

  const imageNameToFetch = isWindows ? `${repo}-win-${windowsYear}` : repo;

  // fetch GA version from backoffice using the repo name as imageName. A
  // variant it does not publish (a Windows year without a build) is left as
  // it is, so the adoption of the other services goes on.
  const info = await fetchAgentInfo(imageNameToFetch).catch(
    (error: unknown) => {
      if (isImageNotPublished(error)) {
        return null;
      }
      throw error;
    },
  );
  const ga = info === null ? null : getVersionByChannel(info, 'ga');

  // If version is null/undefined/empty -> simply exit (no changes).
  if (ga == null || ga === '') {
    return null;
  }

  // Windows images: append "-win-nanoserver-ltsc<version>" suffix
  const finalTag = isWindows ? `${ga}-win-nanoserver-ltsc${windowsYear}` : ga;

  return `molo17/${repo}:${finalTag}`;
};

export default retagThirdPartyImageToMolo17GA;
