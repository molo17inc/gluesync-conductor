import axios from 'axios';

import { getHttpsAgentFor } from '../../utils/axiosWithRetry';
import { canonicalImageName } from '../containerRuntime/canonicalImage';
import parseImage from '../parseImage/parseImage';

const AUTH_URL = 'https://auth.docker.io/token';
const REGISTRY_URL = 'https://registry-1.docker.io/v2';
const DEFAULT_TIMEOUT_MS = 10_000;

// Every manifest type Docker Hub can hold for a tag: an image index (multi
// arch) is what most tags are
const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

export type DockerHubManifest = Readonly<{
  // `sha256:...` of the manifest the tag points to
  digest: string;
}>;

type Reference = Readonly<{ repository: string; reference: string }>;

/**
 * The Docker Hub repository and tag (or digest) of an image, or undefined for
 * an image that lives elsewhere (another registry, or a compose variable).
 */
const dockerHubReference = (image: string): Reference | undefined => {
  if (image.includes('$')) {
    return undefined;
  }

  const { registry, repository, tag, digest } = parseImage(
    canonicalImageName(image),
  );

  if (registry || !repository) {
    return undefined;
  }

  return {
    repository: repository.includes('/') ? repository : `library/${repository}`,
    reference: digest || tag || 'latest',
  };
};

export const isDockerHubImage = (image: string): boolean =>
  dockerHubReference(image) !== undefined;

const requestOptions = (
  url: string,
  headers: Readonly<Record<string, string>>,
  timeoutMs: number,
) => ({
  headers,
  timeout: timeoutMs,
  // The same proxy settings every other outbound call of the Conductor uses
  proxy: false as const,
  httpsAgent: getHttpsAgentFor(url),
  validateStatus: () => true,
});

const anonymousToken = async (
  repository: string,
  timeoutMs: number,
): Promise<string> => {
  const url = `${AUTH_URL}?service=registry.docker.io&scope=${encodeURIComponent(
    `repository:${repository}:pull`,
  )}`;
  const response = await axios.get<{ token?: string; access_token?: string }>(
    url,
    requestOptions(url, {}, timeoutMs),
  );
  const token = response.data?.token ?? response.data?.access_token;

  if (response.status !== 200 || !token) {
    throw new Error(
      `Docker Hub did not give a pull token for ${repository} (HTTP ${response.status})`,
    );
  }

  return token;
};

/**
 * Asks Docker Hub's registry API (a manifest HEAD, with an anonymous token)
 * for the manifest of an image, for engines that cannot ask their registry
 * themselves (Podman's compat API has no `GET /distribution`). Resolves to
 * `undefined` when Docker Hub says the tag does not exist, and to `undefined`
 * as well for an image of another registry. Any other failure (network, rate
 * limit, proxy) rejects.
 */
export const dockerHubManifest = async (
  image: string,
  { timeoutMs = DEFAULT_TIMEOUT_MS }: Readonly<{ timeoutMs?: number }> = {},
): Promise<DockerHubManifest | undefined> => {
  const target = dockerHubReference(image);

  if (!target) {
    return undefined;
  }

  const token = await anonymousToken(target.repository, timeoutMs);
  const url = `${REGISTRY_URL}/${target.repository}/manifests/${target.reference}`;
  const response = await axios.head(
    url,
    requestOptions(
      url,
      { Authorization: `Bearer ${token}`, Accept: MANIFEST_TYPES },
      timeoutMs,
    ),
  );

  if (response.status === 404) {
    return undefined;
  }

  const digest = response.headers?.['docker-content-digest'];

  if (response.status !== 200 || typeof digest !== 'string' || !digest) {
    throw new Error(`Docker Hub answered HTTP ${response.status} for ${image}`);
  }

  return { digest };
};

/**
 * Whether an engine's answer to `GET /distribution` means "this API is not
 * there" (Podman: 404 page not found, or 501) rather than a registry answer.
 */
export const isDistributionUnavailable = (error: unknown): boolean => {
  const { statusCode, message } = (error ?? {}) as Partial<{
    statusCode: number;
    message: string;
  }>;

  return (
    statusCode === 404 ||
    statusCode === 501 ||
    /not implemented|page not found/i.test(String(message ?? ''))
  );
};
