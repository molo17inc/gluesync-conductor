import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type RecordedRequest = Readonly<{
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  // The body parsed as JSON, when it is
  json?: any;
}>;

export type FakeReply = Readonly<{
  status: number;
  // An object is sent as JSON, a string as it is
  body?: unknown;
  headers?: Readonly<Record<string, string>>;
  // Drops the connection instead of answering
  destroy?: boolean;
}>;

export type Interceptor = (request: RecordedRequest) => FakeReply | undefined;

export type FakePortalOptions = Readonly<{
  partBytes?: number;
  maxBytes?: number;
  ticketKey?: string;
}>;

export type FakeSupportPortal = Readonly<{
  /** Base URL of the portal API, without a trailing slash. */
  url: string;
  requests: RecordedRequest[];
  /** What the fake S3 holds: `single`, or the part number. */
  stored: Map<string, Buffer>;
  /** Looked at before the default answer; the first that returns a reply wins. */
  intercept: (interceptor: Interceptor) => void;
  calls: (path: RegExp | string) => RecordedRequest[];
  /** The whole file as the fake S3 holds it, parts in order. */
  assembled: () => Buffer;
  close: () => Promise<void>;
}>;

const UPLOAD_ID = 'up-1';
const SIGNATURE = 'X-Amz-Signature=secret-signature';

const readBody = (req: http.IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const parseJson = (body: Buffer): any => {
  try {
    return body.length > 0 ? JSON.parse(body.toString('utf8')) : undefined;
  } catch {
    return undefined;
  }
};

const send = (res: http.ServerResponse, reply: FakeReply): void => {
  const isText = typeof reply.body === 'string';
  const json = JSON.stringify(reply.body);
  const payload = isText ? (reply.body as string) : (json ?? '');

  res.writeHead(reply.status, {
    ...(reply.body !== undefined && !isText
      ? { 'Content-Type': 'application/json' }
      : {}),
    ...reply.headers,
  });
  res.end(payload);
};

/**
 * A support portal and its S3 on one local HTTP server, for specs: the API of
 * the voucher contract, plus the presigned PUT targets it hands out. Answers
 * the happy path by default; `intercept` scripts the failures.
 */
export const startFakeSupportPortal = async (
  options: FakePortalOptions = {},
): Promise<FakeSupportPortal> => {
  const partBytes = options.partBytes ?? 16 * 1024 * 1024;
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024 * 1024;
  const ticketKey = options.ticketKey ?? 'GSSD-1234';
  const requests: RecordedRequest[] = [];
  const stored = new Map<string, Buffer>();
  const interceptors: Interceptor[] = [];
  const state = { declared: 0, multipart: false, parts: 0, base: '' };

  const single = (headers: Record<string, string> = {}) => ({
    url: `${state.base}/s3/single?${SIGNATURE}`,
    headers,
  });
  const partLink = (partNumber: number) => ({
    partNumber,
    url: `${state.base}/s3/part/${partNumber}?${SIGNATURE}`,
  });

  const answer = (request: RecordedRequest): FakeReply => {
    const { method, path } = request;

    if (method === 'POST' && path === '/support/log-uploads/check') {
      return {
        status: 200,
        body: { ticketKey, voucherExpiresAt: null, maxBytes, partBytes },
      };
    }

    if (method === 'POST' && path === '/support/log-uploads') {
      const headers = { 'Content-Type': 'application/octet-stream' };

      return {
        status: 200,
        body: state.multipart
          ? {
              id: UPLOAD_ID,
              ticketKey,
              expiresIn: 3600,
              multipart: {
                partSize: partBytes,
                parts: Array.from({ length: state.parts }, (_, i) =>
                  partLink(i + 1),
                ),
                headers,
              },
            }
          : {
              id: UPLOAD_ID,
              ticketKey,
              expiresIn: 3600,
              single: single({ 'Content-Type': request.json.contentType }),
            },
      };
    }

    if (
      method === 'POST' &&
      path === `/support/log-uploads/${UPLOAD_ID}/links`
    ) {
      const numbers: number[] | undefined = request.json?.partNumbers;
      return {
        status: 200,
        body: numbers
          ? { expiresIn: 3600, parts: numbers.map(partLink) }
          : { expiresIn: 3600, single: single() },
      };
    }

    if (
      method === 'POST' &&
      path === `/support/log-uploads/${UPLOAD_ID}/complete`
    ) {
      const missing = Array.from(
        { length: state.parts },
        (_, i) => i + 1,
      ).filter(n => !stored.has(String(n)));
      if (state.multipart && missing.length > 0) {
        return {
          status: 409,
          body: {
            error: {
              code: 'upload_incomplete',
              message: 'parts missing',
              missingParts: missing,
            },
          },
        };
      }
      const size = [...stored.values()].reduce(
        (sum, part) => sum + part.length,
        0,
      );
      return {
        status: 200,
        body: {
          id: UPLOAD_ID,
          ticketKey,
          size,
          verified: size === state.declared,
          attachmentId: 'att-1',
        },
      };
    }

    if (
      method === 'POST' &&
      path === `/support/log-uploads/${UPLOAD_ID}/abort`
    ) {
      return { status: 204 };
    }

    if (method === 'PUT' && path === '/s3/single') {
      stored.set('single', request.body);
      return { status: 200 };
    }

    const part = method === 'PUT' ? /^\/s3\/part\/(\d+)$/.exec(path) : null;
    if (part) {
      stored.set(part[1], request.body);
      return { status: 200, headers: { ETag: `"etag-${part[1]}"` } };
    }

    return {
      status: 404,
      body: { error: { code: 'not_found', message: `${method} ${path}` } },
    };
  };

  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const request: RecordedRequest = {
      method: req.method ?? 'GET',
      path: (req.url ?? '').split('?')[0],
      headers: req.headers,
      body,
      json: parseJson(body),
    };
    requests.push(request);

    // What the upload is, even when a spec answers the request itself
    if (request.method === 'POST' && request.path === '/support/log-uploads') {
      state.declared = request.json.size;
      state.multipart = request.json.size > partBytes;
      state.parts = Math.ceil(request.json.size / partBytes);
    }

    const reply =
      interceptors.map(intercept => intercept(request)).find(Boolean) ??
      answer(request);

    if (reply.destroy) {
      req.socket.destroy();
      return;
    }
    send(res, reply);
  });

  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });
  state.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url: state.base,
    requests,
    stored,
    intercept: interceptor => {
      interceptors.push(interceptor);
    },
    calls: path =>
      requests.filter(request =>
        typeof path === 'string'
          ? request.path === path
          : path.test(request.path),
      ),
    assembled: () =>
      Buffer.concat(
        [...stored.entries()]
          .sort(([a], [b]) => Number(a) - Number(b))
          .map(([, buffer]) => buffer),
      ),
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};
