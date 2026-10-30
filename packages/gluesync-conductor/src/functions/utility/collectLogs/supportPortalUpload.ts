/* eslint-disable functional/no-let, functional/no-loop-statements, functional/immutable-data, functional/no-mixed-types, no-await-in-loop, no-continue, no-restricted-syntax -- the retry and refresh loops are sequential by nature (each attempt waits for the last) and keep a few counters and a link table that change as the upload goes; recursion would only add stack frames around awaits */
// Upload of a support bundle into the ticket a voucher belongs to, through the
// support portal (the contract Core Hub and Gluesync Control share):
//   POST {base}/support/log-uploads/check          before collecting: is the voucher good
//   POST {base}/support/log-uploads                starts the upload: one presigned PUT, or parts
//   PUT  <presigned S3 URL>                        the bytes, streamed from disk, Content-Length set
//   POST {base}/support/log-uploads/{id}/links     fresh links (expired, or parts sent again)
//   POST {base}/support/log-uploads/{id}/complete  the portal joins the parts and attaches the file
//   POST {base}/support/log-uploads/{id}/abort     after a failure
// Every call goes through the proxy Conductor already uses (PROXY_HTTPS /
// PROXY_HTTP, NO_PROXY), the voucher travels only in `X-Gluesync-Voucher`, and
// there is no fallback to WebDAV or FTP on this path.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { hostname as osHostname, release as osRelease, type } from 'node:os';
import axios, { AxiosRequestConfig } from 'axios';
import packageJson from '../../../../package.json';
import { getHttpsAgentFor } from '../../../utils/axiosWithRetry';
import { redactSecrets } from '../../../utils/redact';
import { redactVouchers } from './supportVoucher';

export const SUPPORT_API_URL_ENV = 'GLUESYNC_SUPPORT_API_URL';
export const SUPPORT_API_DEFAULT_URL =
  'https://ot57o7swl7.execute-api.eu-central-1.amazonaws.com/prod';
export const SUPPORT_MAX_BYTES = 5 * 1024 * 1024 * 1024;

export type SupportPortalErrorCode =
  | 'voucher_format'
  | 'voucher_invalid'
  | 'voucher_expired'
  | 'file_too_large'
  | 'rate_limited'
  | 'portal_unreachable';

/**
 * A failure of the portal upload. With a `code` the REST client has an answer
 * of its own (`httpStatus` says which); without one it is a plain failure
 * (HTTP 500) such as a refusal the contract has no name for.
 */
export type SupportPortalError = Error &
  Readonly<{
    isSupportPortalError: true;
    code?: SupportPortalErrorCode;
    httpStatus: number;
    maxBytes?: number;
    details?: string;
  }>;

type SupportPortalErrorInit = Readonly<{
  code?: SupportPortalErrorCode;
  httpStatus: number;
  maxBytes?: number;
  details?: string;
  cause?: unknown;
}>;

export const createSupportPortalError = (
  message: string,
  init: SupportPortalErrorInit,
): SupportPortalError =>
  Object.assign(new Error(message, { cause: init.cause }), {
    isSupportPortalError: true as const,
    code: init.code,
    httpStatus: init.httpStatus,
    maxBytes: init.maxBytes,
    details: init.details,
  });

export const isSupportPortalError = (
  error: unknown,
): error is SupportPortalError =>
  error instanceof Error &&
  'isSupportPortalError' in error &&
  error.isSupportPortalError === true;

export type PortalCheck = Readonly<{
  ticketKey: string;
  voucherExpiresAt: string | null;
  maxBytes: number;
  partBytes: number;
}>;

export type PortalUploadResult = Readonly<{
  ticketKey: string;
  size: number;
  verified: boolean;
}>;

export type PortalLogger = Readonly<{
  info: (obj: Readonly<Record<string, unknown>> | string, msg?: string) => void;
  warn: (obj: Readonly<Record<string, unknown>> | string, msg?: string) => void;
}>;

export type SupportPortalClientOptions = Readonly<{
  /** Defaults to GLUESYNC_SUPPORT_API_URL, then to production. */
  baseUrl?: string;
  /** Defaults to CONDUCTOR_VERSION, then to the package version. */
  version?: string;
  logger?: PortalLogger;
  /** Waits between retries; specs replace it. */
  pause?: (ms: number) => Promise<void>;
  backoffMs?: number;
}>;

export type SupportPortalClient = Readonly<{
  check: (voucher: string) => Promise<PortalCheck>;
  upload: (
    voucher: string,
    filePath: string,
    contentType: string,
    check?: PortalCheck,
  ) => Promise<PortalUploadResult>;
}>;

const VOUCHER_HEADER = 'X-Gluesync-Voucher';
const CHECK_PATH = '/support/log-uploads/check';
const UPLOADS_PATH = '/support/log-uploads';
const MAX_ATTEMPTS = 3;
const MAX_LINK_REFRESHES = 3;
const MAX_COMPLETE_ROUNDS = 3;
const DEFAULT_BACKOFF_MS = 500;
const MAX_RATE_LIMIT_WAIT_SECONDS = 30;
const PORTAL_TIMEOUT_MS = 60_000;
const ABORT_TIMEOUT_MS = 10_000;
const SLICE_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_SOURCE_FIELD = 255;
const REQUEST_TIMEOUT = 408;
const TOO_MANY_REQUESTS = 429;
const EXPIRED_MARKER = /expired/i;
const URL_QUERY = /(https?:\/\/[^\s?'"\])]+)\?[^\s'"\])]*/g;

/** The override of the environment when it is not blank, otherwise production; never ends with a slash. */
export const resolveSupportApiUrl = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): string =>
  (env[SUPPORT_API_URL_ENV]?.trim() || SUPPORT_API_DEFAULT_URL).replace(
    /\/+$/,
    '',
  );

export const resolveConductorVersion = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): string =>
  env.CONDUCTOR_VERSION?.trim() ||
  (packageJson as Readonly<{ version?: string }>).version ||
  'unknown';

const CONTENT_TYPES: ReadonlyArray<readonly [string, string]> = [
  ['.tar.gz', 'application/gzip'],
  ['.tgz', 'application/gzip'],
  ['.tar.zst', 'application/zstd'],
  ['.tar.xz', 'application/x-xz'],
  ['.zip', 'application/zip'],
];

/** The content type the portal is told, from the extension of the archive. */
export const contentTypeForArchive = (archivePath: string): string => {
  const lower = archivePath.toLowerCase();
  return (
    CONTENT_TYPES.find(([extension]) => lower.endsWith(extension))?.[1] ??
    'application/octet-stream'
  );
};

type HttpReply = Readonly<{
  status: number;
  body: string;
  retryAfterSeconds?: number;
}>;

type Target = Readonly<{
  url: string;
  headers: Readonly<Record<string, string>>;
}>;

type PartLink = Readonly<{ partNumber: number; url: string }>;

type Multipart = Readonly<{
  partSize: number;
  parts: ReadonlyArray<PartLink>;
  headers: Readonly<Record<string, string>>;
}>;

type CreatedUpload = Readonly<{
  id: string;
  ticketKey: string;
  single?: Target;
  multipart?: Multipart;
}>;

type PortalErrorBody = Readonly<{
  code?: string;
  message?: string;
  maxBytes?: number;
  missingParts?: ReadonlyArray<number>;
}>;

type SliceOutcome =
  | Readonly<{ kind: 'sent' }>
  | Readonly<{ kind: 'expired' }>
  | Readonly<{ kind: 'rejected'; reason: string }>
  | Readonly<{ kind: 'retry'; reason: string }>;

type Json = Readonly<Record<string, unknown>>;

const defaultPause = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return 'support portal';
  }
};

/** A failure as a line for a log or an error: no presigned query strings, proxy credentials or vouchers. */
const describeFailure = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  const text = `${typeof code === 'string' ? `${code}: ` : ''}${raw}`;

  return redactVouchers(redactSecrets(text.replace(URL_QUERY, '$1')));
};

const unreadable = (status: number, cause?: unknown): SupportPortalError =>
  createSupportPortalError(
    `The support portal gave an answer Conductor cannot read (HTTP ${status}).`,
    { httpStatus: 500, cause },
  );

const parseJson = (reply: HttpReply): Json => {
  try {
    const parsed: unknown = JSON.parse(reply.body);

    if (isRecord(parsed)) {
      return parsed;
    }
  } catch (error) {
    throw unreadable(reply.status, error);
  }

  throw unreadable(reply.status);
};

const readString = (reply: HttpReply, source: Json, key: string): string => {
  const value = source[key];

  if (typeof value !== 'string' || value === '') {
    throw unreadable(reply.status);
  }

  return value;
};

const readNumber = (source: Json, key: string): number | undefined =>
  typeof source[key] === 'number' ? source[key] : undefined;

const readHeaders = (value: unknown): Readonly<Record<string, string>> =>
  isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
    : {};

const readTarget = (value: unknown): Target | undefined =>
  isRecord(value) && typeof value.url === 'string'
    ? { url: value.url, headers: readHeaders(value.headers) }
    : undefined;

const readParts = (value: unknown): ReadonlyArray<PartLink> =>
  Array.isArray(value)
    ? value.flatMap((part: unknown) =>
        isRecord(part) &&
        typeof part.partNumber === 'number' &&
        typeof part.url === 'string'
          ? [{ partNumber: part.partNumber, url: part.url }]
          : [],
      )
    : [];

const readMultipart = (value: unknown): Multipart | undefined =>
  isRecord(value) && typeof value.partSize === 'number'
    ? {
        partSize: value.partSize,
        parts: readParts(value.parts),
        headers: readHeaders(value.headers),
      }
    : undefined;

const parseRetryAfter = (value: unknown): number | undefined => {
  const seconds = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
};

// follow-redirects (axios) copies a streamed body into memory so that it can
// replay it after a redirect: maxRedirects 0 keeps a 5 GB part on disk.
const sendHttp = async (
  config: Readonly<AxiosRequestConfig>,
): Promise<HttpReply> => {
  const agent = config.url ? getHttpsAgentFor(config.url) : undefined;
  const response = await axios<string>({
    ...config,
    proxy: false,
    httpAgent: agent,
    httpsAgent: agent,
    maxRedirects: 0,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    responseType: 'text',
    transformResponse: [(data: unknown) => data],
    validateStatus: () => true,
  });

  return {
    status: response.status,
    body: typeof response.data === 'string' ? response.data : '',
    retryAfterSeconds: parseRetryAfter(response.headers?.['retry-after']),
  };
};

const withoutHeader = (
  headers: Readonly<Record<string, string>>,
  name: string,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers).filter(([key]) => key.toLowerCase() !== name),
  );

const hasHeader = (
  headers: Readonly<Record<string, string>>,
  name: string,
): boolean => Object.keys(headers).some(key => key.toLowerCase() === name);

const detectSource = (version: string): Json => ({
  client: 'conductor',
  version,
  hostname: osHostname().slice(0, MAX_SOURCE_FIELD),
  os: `${type()} ${osRelease()}`.trim().slice(0, MAX_SOURCE_FIELD),
});

export const createSupportPortalClient = (
  options: SupportPortalClientOptions = {},
): SupportPortalClient => {
  const {
    logger,
    pause = defaultPause,
    backoffMs = DEFAULT_BACKOFF_MS,
  } = options;
  const baseUrl = (options.baseUrl ?? resolveSupportApiUrl()).replace(
    /\/+$/,
    '',
  );
  const version = options.version ?? resolveConductorVersion();
  const userAgent = `GluesyncConductor/${version}`;

  const unreachable = (reason: string): SupportPortalError =>
    createSupportPortalError(
      `The support portal could not be reached (${hostOf(baseUrl)}): ${reason}. Check that this host can reach the portal and *.s3.eu-central-1.amazonaws.com, through the proxy if one is needed.`,
      { code: 'portal_unreachable', httpStatus: 502 },
    );

  const errorOf = (reply: HttpReply): PortalErrorBody | undefined => {
    try {
      const parsed: unknown = JSON.parse(reply.body);
      const error = isRecord(parsed) ? parsed.error : undefined;

      return isRecord(error)
        ? {
            code: typeof error.code === 'string' ? error.code : undefined,
            message:
              typeof error.message === 'string' ? error.message : undefined,
            maxBytes: readNumber(error, 'maxBytes'),
            missingParts: Array.isArray(error.missingParts)
              ? error.missingParts.filter(
                  (part): part is number => typeof part === 'number',
                )
              : undefined,
          }
        : undefined;
    } catch {
      return undefined;
    }
  };

  // A refusal of the portal, in the codes the REST client knows
  const refusal = (reply: HttpReply): SupportPortalError => {
    const error = errorOf(reply);

    if (reply.status === 401 || error?.code === 'voucher_invalid') {
      return createSupportPortalError(
        'The voucher is not valid: it is unknown or has been revoked.',
        { code: 'voucher_invalid', httpStatus: 400 },
      );
    }
    if (reply.status === 410 || error?.code === 'voucher_expired') {
      return createSupportPortalError(
        'The voucher has expired: its ticket was closed more than 30 days ago.',
        { code: 'voucher_expired', httpStatus: 400 },
      );
    }
    if (reply.status === 413 || error?.code === 'file_too_large') {
      const maxBytes = error?.maxBytes ?? SUPPORT_MAX_BYTES;
      return createSupportPortalError(
        `The archive is too large: the support portal accepts at most ${maxBytes} bytes.`,
        { code: 'file_too_large', httpStatus: 400, maxBytes },
      );
    }
    if (reply.status === TOO_MANY_REQUESTS) {
      const hint =
        reply.retryAfterSeconds === undefined
          ? 'later.'
          : `in ${reply.retryAfterSeconds} seconds.`;
      return createSupportPortalError(
        `The support portal is limiting requests from this host: try again ${hint}`,
        { code: 'rate_limited', httpStatus: 429 },
      );
    }

    const detail = redactVouchers(error?.message ?? `HTTP ${reply.status}`);
    return createSupportPortalError(
      `The support portal refused the request (HTTP ${reply.status}${error?.code ? `, ${error.code}` : ''}): ${detail}`,
      { httpStatus: 500 },
    );
  };

  const postOnce = (
    voucher: string,
    path: string,
    body: Json,
    timeout: number,
  ): Promise<HttpReply> =>
    sendHttp({
      url: `${baseUrl}${path}`,
      method: 'POST',
      data: JSON.stringify(body),
      timeout,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': userAgent,
        [VOUCHER_HEADER]: voucher,
      },
    });

  // One call to the portal, retried on a server error or a broken connection,
  // waiting once when it rate limits, and mapped to the client's codes.
  const portalPost = async (
    voucher: string,
    path: string,
    body: Json = {},
    passthrough: ReadonlyArray<number> = [],
  ): Promise<HttpReply> => {
    let attempt = 0;
    let waitedForRateLimit = false;

    for (;;) {
      attempt += 1;
      let reply: HttpReply;

      try {
        reply = await postOnce(voucher, path, body, PORTAL_TIMEOUT_MS);
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS) {
          // The axios error is not kept as the cause: its config holds the request headers, voucher included
          throw unreachable(describeFailure(error));
        }
        logger?.warn(
          { path, attempt },
          `The support portal call failed (${describeFailure(error)}), retrying.`,
        );
        await pause(backoffMs * attempt);
        continue;
      }

      if (
        (reply.status >= 200 && reply.status < 300) ||
        passthrough.includes(reply.status)
      ) {
        return reply;
      }

      if (reply.status === TOO_MANY_REQUESTS) {
        const wait = reply.retryAfterSeconds;

        if (
          waitedForRateLimit ||
          wait === undefined ||
          wait > MAX_RATE_LIMIT_WAIT_SECONDS
        ) {
          throw refusal(reply);
        }
        waitedForRateLimit = true;
        logger?.warn(
          { path },
          `The support portal is rate limiting this host: waiting ${wait} s once.`,
        );
        await pause(wait * 1000);
        continue;
      }

      if (reply.status >= 500) {
        if (attempt >= MAX_ATTEMPTS) {
          throw unreachable(`it answered HTTP ${reply.status}`);
        }
        logger?.warn(
          { path, attempt },
          `The support portal answered HTTP ${reply.status}, retrying.`,
        );
        await pause(backoffMs * attempt);
        continue;
      }

      throw refusal(reply);
    }
  };

  const check = async (voucher: string): Promise<PortalCheck> => {
    logger?.info('Checking the support voucher');
    const reply = await portalPost(voucher, CHECK_PATH);
    const body = parseJson(reply);

    return {
      ticketKey: readString(reply, body, 'ticketKey'),
      voucherExpiresAt:
        typeof body.voucherExpiresAt === 'string'
          ? body.voucherExpiresAt
          : null,
      maxBytes: readNumber(body, 'maxBytes') ?? 0,
      partBytes: readNumber(body, 'partBytes') ?? 0,
    };
  };

  const create = async (
    voucher: string,
    request: Json,
  ): Promise<CreatedUpload> => {
    const reply = await portalPost(voucher, UPLOADS_PATH, request);
    const body = parseJson(reply);

    return {
      id: readString(reply, body, 'id'),
      ticketKey: readString(reply, body, 'ticketKey'),
      single: readTarget(body.single),
      multipart: readMultipart(body.multipart),
    };
  };

  const putSlice = async (
    filePath: string,
    target: Target,
    offset: number,
    length: number,
  ): Promise<SliceOutcome> => {
    // Streamed from the file: never more than a chunk in memory
    const stream = createReadStream(filePath, {
      start: offset,
      end: offset + length - 1,
    });

    try {
      const declared = withoutHeader(target.headers, 'content-length');
      const reply = await sendHttp({
        url: target.url,
        method: 'PUT',
        data: stream,
        timeout: SLICE_TIMEOUT_MS,
        headers: {
          ...(hasHeader(declared, 'content-type')
            ? {}
            : { 'Content-Type': 'application/octet-stream' }),
          ...declared,
          'User-Agent': userAgent,
          'Content-Length': String(length),
        },
      });

      if (reply.status >= 200 && reply.status < 300) {
        return { kind: 'sent' };
      }
      if (reply.status === 403 && EXPIRED_MARKER.test(reply.body)) {
        return { kind: 'expired' };
      }
      if (
        reply.status >= 500 ||
        reply.status === REQUEST_TIMEOUT ||
        reply.status === TOO_MANY_REQUESTS
      ) {
        return { kind: 'retry', reason: `with HTTP ${reply.status}` };
      }

      return { kind: 'rejected', reason: `HTTP ${reply.status}` };
    } catch (error) {
      return { kind: 'retry', reason: describeFailure(error) };
    } finally {
      stream.destroy();
    }
  };

  // Sends one slice of the file, asking for new links when S3 says they expired
  const sendSlice = async (
    filePath: string,
    uploadId: string,
    slice: Readonly<{
      label: string;
      offset: number;
      length: number;
      targetOf: () => Target;
      refresh: () => Promise<void>;
    }>,
  ): Promise<void> => {
    let failures = 0;
    let refreshes = 0;

    for (;;) {
      const target = slice.targetOf();
      const outcome = await putSlice(
        filePath,
        target,
        slice.offset,
        slice.length,
      );

      if (outcome.kind === 'sent') {
        return;
      }
      if (outcome.kind === 'expired') {
        refreshes += 1;
        if (refreshes > MAX_LINK_REFRESHES) {
          throw createSupportPortalError(
            `The links of upload ${uploadId} kept expiring.`,
            { httpStatus: 500 },
          );
        }
        await slice.refresh();
        continue;
      }
      if (outcome.kind === 'rejected') {
        throw createSupportPortalError(
          `The storage refused ${slice.label} of the archive: ${outcome.reason}`,
          { httpStatus: 500 },
        );
      }

      failures += 1;
      if (failures >= MAX_ATTEMPTS) {
        throw unreachable(
          `${slice.label} failed (${outcome.reason}) on ${hostOf(target.url)}`,
        );
      }
      logger?.warn(
        { attempt: failures },
        `Sending ${slice.label} failed (${outcome.reason}), retrying.`,
      );
      await pause(backoffMs * failures);
    }
  };

  const linksPath = (uploadId: string): string =>
    `${UPLOADS_PATH}/${encodeURIComponent(uploadId)}/links`;

  const refreshSingle = async (
    voucher: string,
    uploadId: string,
  ): Promise<Target> => {
    logger?.info('The link of the upload expired: asking for a new one.');
    const reply = await portalPost(voucher, linksPath(uploadId));
    const links = readTarget(parseJson(reply).single);

    if (!links) {
      throw createSupportPortalError(
        `The support portal gave no new link for upload ${uploadId}.`,
        { httpStatus: 500 },
      );
    }

    return links;
  };

  const refreshParts = async (
    voucher: string,
    uploadId: string,
    partNumbers: ReadonlyArray<number>,
  ): Promise<ReadonlyArray<PartLink>> => {
    logger?.info(
      { parts: partNumbers.length },
      'Asking the support portal for new links.',
    );
    const reply = await portalPost(voucher, linksPath(uploadId), {
      partNumbers,
    });

    return readParts(parseJson(reply).parts);
  };

  const sendSingle = (
    voucher: string,
    filePath: string,
    upload: CreatedUpload,
    initial: Target,
    size: number,
  ): Promise<void> => {
    let target = initial;

    return sendSlice(filePath, upload.id, {
      label: 'the archive',
      offset: 0,
      length: size,
      targetOf: () => target,
      refresh: async () => {
        target = await refreshSingle(voucher, upload.id);
      },
    });
  };

  // Sends `partNumbers` of `multipart`: the links of `given` are used first,
  // the others are asked for.
  const sendParts = async (
    voucher: string,
    filePath: string,
    upload: CreatedUpload,
    multipart: Multipart,
    partNumbers: ReadonlyArray<number>,
    given: ReadonlyArray<PartLink>,
    size: number,
  ): Promise<void> => {
    if (multipart.partSize <= 0) {
      throw createSupportPortalError(
        `The support portal gave a part size of ${multipart.partSize}.`,
        { httpStatus: 500 },
      );
    }

    const links = new Map(given.map(part => [part.partNumber, part.url]));
    const addLinks = (fresh: ReadonlyArray<PartLink>): void => {
      fresh.forEach(part => links.set(part.partNumber, part.url));
    };

    if (partNumbers.some(number => !links.has(number))) {
      addLinks(await refreshParts(voucher, upload.id, partNumbers));
    }

    for (const [index, number] of partNumbers.entries()) {
      const offset = (number - 1) * multipart.partSize;

      if (number < 1 || offset >= size) {
        throw createSupportPortalError(
          `The support portal asked for part ${number} of an archive of ${size} bytes.`,
          { httpStatus: 500 },
        );
      }

      await sendSlice(filePath, upload.id, {
        label: `part ${number}`,
        offset,
        length: Math.min(multipart.partSize, size - offset),
        targetOf: () => {
          const url = links.get(number);

          if (!url) {
            throw createSupportPortalError(
              `The support portal gave no link for part ${number}.`,
              { httpStatus: 500 },
            );
          }

          return { url, headers: multipart.headers };
        },
        refresh: async () => {
          addLinks(
            await refreshParts(voucher, upload.id, partNumbers.slice(index)),
          );
        },
      });
    }
  };

  // The portal joins the parts; a 409 names the ones it misses: send them again
  const complete = async (
    voucher: string,
    filePath: string,
    upload: CreatedUpload,
    size: number,
  ): Promise<PortalUploadResult> => {
    let rounds = 0;

    for (;;) {
      const reply = await portalPost(
        voucher,
        `${UPLOADS_PATH}/${encodeURIComponent(upload.id)}/complete`,
        {},
        [409],
      );

      if (reply.status !== 409) {
        const body = parseJson(reply);

        return {
          ticketKey: readString(reply, body, 'ticketKey'),
          size: readNumber(body, 'size') ?? size,
          verified: body.verified === true,
        };
      }

      const missing = [...(errorOf(reply)?.missingParts ?? [])].sort(
        (a, b) => a - b,
      );
      rounds += 1;

      if (
        !upload.multipart ||
        missing.length === 0 ||
        rounds > MAX_COMPLETE_ROUNDS
      ) {
        throw createSupportPortalError(
          `The support portal could not join the upload. Missing parts: ${missing.join(', ') || 'unknown'}`,
          { httpStatus: 500 },
        );
      }

      logger?.warn(
        { missing },
        'The support portal is missing parts of the upload: sending them again.',
      );
      await sendParts(
        voucher,
        filePath,
        upload,
        upload.multipart,
        missing,
        [],
        size,
      );
    }
  };

  // Best effort: a failed upload tells the portal to drop what it holds
  const abort = async (voucher: string, uploadId: string): Promise<void> => {
    try {
      const reply = await postOnce(
        voucher,
        `${UPLOADS_PATH}/${encodeURIComponent(uploadId)}/abort`,
        {},
        ABORT_TIMEOUT_MS,
      );
      logger?.info(
        `Aborted the upload: the portal answered HTTP ${reply.status}.`,
      );
    } catch (error) {
      logger?.warn(`Could not abort the upload: ${describeFailure(error)}`);
    }
  };

  const upload = async (
    voucher: string,
    filePath: string,
    contentType: string,
    known?: PortalCheck,
  ): Promise<PortalUploadResult> => {
    const portalCheck = known ?? (await check(voucher));
    const { size } = await stat(filePath);
    const maxBytes = Math.min(
      portalCheck.maxBytes > 0 ? portalCheck.maxBytes : SUPPORT_MAX_BYTES,
      SUPPORT_MAX_BYTES,
    );

    if (size > maxBytes) {
      throw createSupportPortalError(
        `The archive is ${size} bytes: the support portal accepts at most ${maxBytes} bytes.`,
        { code: 'file_too_large', httpStatus: 400, maxBytes },
      );
    }
    if (size <= 0) {
      throw createSupportPortalError('The archive is empty.', {
        httpStatus: 500,
      });
    }

    const filename = filePath.split(/[\\/]/).pop() ?? filePath;
    const created = await create(voucher, {
      filename,
      size,
      contentType,
      source: detectSource(version),
    });

    logger?.info(
      { ticketKey: created.ticketKey, size },
      'Uploading the archive to the support portal.',
    );

    try {
      const { multipart, single } = created;

      if (single) {
        await sendSingle(voucher, filePath, created, single, size);
      } else if (multipart) {
        await sendParts(
          voucher,
          filePath,
          created,
          multipart,
          multipart.parts.map(part => part.partNumber).sort((a, b) => a - b),
          multipart.parts,
          size,
        );
      } else {
        throw createSupportPortalError(
          'The support portal gave no place to send the archive to.',
          { httpStatus: 500 },
        );
      }

      const done = await complete(voucher, filePath, created, size);
      logger?.info(
        { ticketKey: done.ticketKey, size: done.size, verified: done.verified },
        'The support portal completed the upload.',
      );

      return done;
    } catch (error) {
      await abort(voucher, created.id);
      throw error;
    }
  };

  return { check, upload };
};
