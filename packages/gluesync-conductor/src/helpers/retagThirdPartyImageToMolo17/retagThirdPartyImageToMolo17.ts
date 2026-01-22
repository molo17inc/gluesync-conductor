import fetchAgentInfo from '../agentInfo/agentInfo';
import getVersionByChannel from '../releaseChannel/getVersionByChannel';

export type ThirdPartyRepo = 'traefik' | 'prometheus' | 'grafana' | 'portainer';

export const THIRD_PARTY_REPOS: ReadonlyArray<ThirdPartyRepo> = [
  'traefik',
  'prometheus',
  'grafana',
  'portainer',
];

export const toThirdPartyRepo = (image: string): ThirdPartyRepo | null => {
  const lower = (image || '').toLowerCase();

  // use substring match exactly as requested
  if (lower.includes('traefik')) return 'traefik';
  if (lower.includes('prometheus')) return 'prometheus';
  if (lower.includes('grafana')) return 'grafana';
  if (lower.includes('portainer')) return 'portainer';

  return null;
};

export const isMolo17Image = (image: string, repo: ThirdPartyRepo): boolean => {
  // accept both "molo17/repo" and "docker.io/molo17/repo"
  const lower = (image || '').toLowerCase();
  return lower.includes(`molo17/${repo}`);
};

export const retagThirdPartyImageToMolo17GA = async (
  image: string,
  isWindows: boolean,
  windowsYear?: string,
): Promise<string | null> => {
  const repo = toThirdPartyRepo(image);
  if (!repo || (isWindows && !windowsYear)) return null;

  // already molo17/<repo>:<tag> -> do nothing
  if (isMolo17Image(image, repo)) return null;

  const imageNameToFetch = isWindows ? `${repo}-win` : repo;

  // fetch GA version from backoffice using the repo name as imageName
  const info = await fetchAgentInfo(imageNameToFetch);
  const ga = getVersionByChannel(info, 'ga');

  // If version is null/undefined/empty -> simply exit (no changes).
  if (ga == null || ga === '') return null;

  // Windows images: append "-win-nanoserver-ltsc<version>" suffix
  const finalTag = isWindows ? `${ga}-win-nanoserver-ltsc${windowsYear}` : ga;

  return `molo17/${repo}:${finalTag}`;
};

export default retagThirdPartyImageToMolo17GA;
