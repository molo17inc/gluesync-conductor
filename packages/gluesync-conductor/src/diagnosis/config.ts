export type DiagnosisConfig = Readonly<{
  backofficeBaseUrl: string;
  statusApiUrl: string;
  internetIpUrl: string;
  internetNameUrl: string;
  /** Service id of the OTA entry inside the public status feed. */
  otaStatusServiceId: string;
  /**
   * Registries to probe instead of the ones the compose images imply. Entries are
   * a host or a full base URL. For mirrors and air-gapped installs.
   */
  registryOverride?: ReadonlyArray<string>;
  probeTimeoutMs: number;
  /** How long a probe run is reused by later checks. */
  cacheTtlMs: number;
  /** A forced refresh within this window still reuses the last run (rate limit). */
  minRefreshIntervalMs: number;
  /** A status feed older than this is not trusted as proof that MOLO17 is fine. */
  statusStaleAfterMs: number;
}>;

// URLs come from the environment only, never from a request, so the probe
// targets cannot be steered by a caller.
const readUrl = (name: string, fallback: string): string => {
  const value = process.env[name]?.trim();

  if (!value) {
    return fallback;
  }

  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:' ? value : fallback;
  } catch {
    return fallback;
  }
};

const readList = (name: string): ReadonlyArray<string> | undefined => {
  const entries = (process.env[name] ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry !== '');

  return entries.length > 0 ? entries : undefined;
};

const readPositiveNumber = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/** Read on every call so tests and operators can change the environment. */
export const getDiagnosisConfig = (): DiagnosisConfig => ({
  backofficeBaseUrl: readUrl(
    'GLUESYNC_BACKOFFICE_URL',
    'https://api.backoffice.molo17.com',
  ),
  statusApiUrl: readUrl(
    'GLUESYNC_STATUS_API_URL',
    'https://aw53uno6n5.execute-api.eu-central-1.amazonaws.com/prod/status',
  ),
  internetIpUrl: readUrl(
    'GLUESYNC_DIAGNOSIS_INTERNET_IP_URL',
    'https://1.1.1.1/cdn-cgi/trace',
  ),
  internetNameUrl: readUrl(
    'GLUESYNC_DIAGNOSIS_INTERNET_NAME_URL',
    'https://www.google.com/generate_204',
  ),
  otaStatusServiceId: 'ota-update-services',
  registryOverride: readList('GLUESYNC_DIAGNOSIS_REGISTRY_HOSTS'),
  probeTimeoutMs: readPositiveNumber('GLUESYNC_DIAGNOSIS_TIMEOUT_MS', 4000),
  cacheTtlMs: readPositiveNumber('GLUESYNC_DIAGNOSIS_CACHE_TTL_MS', 30_000),
  minRefreshIntervalMs: readPositiveNumber(
    'GLUESYNC_DIAGNOSIS_MIN_REFRESH_MS',
    5000,
  ),
  // The public feed refreshes on a slow cadence (about 30 minutes observed).
  statusStaleAfterMs:
    readPositiveNumber('GLUESYNC_STATUS_STALE_MINUTES', 60) * 60_000,
});

/** The backoffice probe hits the same endpoint family OTA uses. */
export const getBackofficeProbeUrl = (config: DiagnosisConfig): string =>
  `${config.backofficeBaseUrl}/agent/conductor/version`;
