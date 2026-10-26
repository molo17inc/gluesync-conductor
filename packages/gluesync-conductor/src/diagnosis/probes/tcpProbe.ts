import net from 'node:net';
import { classifyProbeError } from './classifyProbeError';
import { ProbeResult } from './probe.model';

/**
 * Opens a raw TCP connection. Used for the configured proxy: axios reports
 * "proxy refused" and "target refused" identically, so the proxy is checked on its own.
 */
const runTcpProbe = (
  host: string,
  port: number,
  timeoutMs: number,
  now: () => number = () => Date.now(),
): Promise<ProbeResult> =>
  new Promise(resolve => {
    const startedAt = now();
    const socket = net.connect({ host, port });

    const finish = (partial: Omit<ProbeResult, 'id' | 'ms' | 'host'>) => {
      socket.destroy();
      resolve({
        id: 'proxy',
        ms: now() - startedAt,
        host,
        ...partial,
      });
    };

    socket.setTimeout(timeoutMs);

    socket.once('connect', () =>
      finish({
        reachable: true,
        healthy: true,
        detail: `${host}:${port} accepts connections`,
      }),
    );

    socket.once('timeout', () =>
      finish({
        reachable: false,
        healthy: false,
        errorKind: 'timeout',
        detail: `${host}:${port} timed out`,
      }),
    );

    socket.once('error', error => {
      const failure = classifyProbeError(error);
      const codeSuffix = failure.code ? ` (${failure.code})` : '';

      finish({
        reachable: false,
        healthy: false,
        errorKind: failure.kind,
        errorCode: failure.code,
        detail: `${host}:${port} ${failure.kind ?? 'failed'}${codeSuffix}`,
      });
    });
  });

export default runTcpProbe;
