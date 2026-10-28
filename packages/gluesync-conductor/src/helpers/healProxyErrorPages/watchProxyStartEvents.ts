import type Docker from 'dockerode';
import type { Readable } from 'node:stream';

import { LabelPrefix } from '../../models/composeFile.model';
import { getLogger } from '../../utils/logger';
import healProxyErrorPages, {
  isHealing,
  ownRecreateEndedAt,
} from './healProxyErrorPages';
import type { HealProxyErrorPages } from './healProxyErrorPages.model';

const DEBOUNCE_MS = 10_000;
const RECONNECT_MS = 5_000;
// The Conductor's own recreate ends a moment after the container started
const OWN_EVENT_SLACK_MS = 2_000;

export type ProxyEventWatcher = Readonly<{ stop: () => void }>;

// eslint-disable-next-line functional/no-mixed-types
export type ProxyEventWatcherOptions = Readonly<{
  docker: Readonly<Pick<Docker, 'getEvents'>>;
  proxyServiceName: string;
  /** True while something else (an update) works on the compose file: wait. */
  isBusy?: () => boolean;
  heal?: HealProxyErrorPages;
  debounceMs?: number;
  reconnectMs?: number;
  ownRecreateEndedAt?: () => number;
  isHealing?: () => boolean;
}>;

type DockerEvent = Readonly<{ time?: number; timeNano?: number }>;

const eventMs = (event: DockerEvent): number =>
  event.timeNano === undefined
    ? (event.time ?? Math.floor(Date.now() / 1000)) * 1000
    : Math.floor(event.timeNano / 1e6);

const parseEvents = (chunk: Buffer | string): ReadonlyArray<DockerEvent> =>
  chunk
    .toString('utf8')
    .split(/\r?\n/)
    .filter(line => line.trim() !== '')
    .flatMap(line => {
      try {
        return [JSON.parse(line) as DockerEvent];
      } catch {
        return [];
      }
    });

/**
 * Runs the error pages heal after the reverse-proxy container starts (its
 * image can change under the Conductor: `docker compose up`, a manual pull,
 * the Control tool). Debounced; it waits while an update is running; and the
 * start of the container the heal itself recreated is not a reason to run.
 */
const watchProxyStartEvents = (
  options: ProxyEventWatcherOptions,
): ProxyEventWatcher => {
  const {
    docker,
    proxyServiceName,
    isBusy = () => false,
    heal = healProxyErrorPages,
    debounceMs = DEBOUNCE_MS,
    reconnectMs = RECONNECT_MS,
  } = options;
  const ownEnd = options.ownRecreateEndedAt ?? ownRecreateEndedAt;
  const healing = options.isHealing ?? isHealing;
  const logger = getLogger();
  const cell = new Map<string, unknown>([
    ['stopped', false],
    ['timer', undefined],
    ['pending', 0],
    ['stream', undefined],
    ['reconnecting', false],
  ]);

  const timer = (): NodeJS.Timeout | undefined =>
    cell.get('timer') as NodeJS.Timeout | undefined;

  const arm = (fire: () => void): void => {
    const previous = timer();

    if (previous) {
      clearTimeout(previous);
    }

    cell.set(
      'timer',
      setTimeout(() => {
        cell.set('timer', undefined);
        fire();
      }, debounceMs).unref(),
    );
  };

  const tick = async (): Promise<void> => {
    const startedAt = cell.get('pending') as number;

    if (cell.get('stopped') || startedAt === 0) {
      return;
    }

    if (isBusy() || healing()) {
      arm(() => {
        tick().catch(() => undefined);
      });
      return;
    }

    cell.set('pending', 0);

    if (startedAt <= ownEnd() + OWN_EVENT_SLACK_MS) {
      logger.debug(
        `[proxy-error-pages] ${proxyServiceName} started by the heal itself, ignored`,
      );
      return;
    }

    await heal({ reason: 'event' });
  };

  const runTick = (): void => {
    tick().catch(() => undefined);
  };

  const onEvents = (chunk: Buffer | string): void => {
    const events = parseEvents(chunk);

    if (events.length === 0) {
      return;
    }

    cell.set(
      'pending',
      Math.max(cell.get('pending') as number, ...events.map(eventMs)),
    );
    arm(runTick);
  };

  const connect = async (): Promise<void> => {
    if (cell.get('stopped')) {
      return;
    }

    // `error` and `end` both come for one dropped stream: one reconnect
    const reconnect = (): void => {
      if (cell.get('stopped') || cell.get('reconnecting')) {
        return;
      }

      cell.set('reconnecting', true);
      setTimeout(() => {
        cell.set('reconnecting', false);
        connect().catch(() => undefined);
      }, reconnectMs).unref();
    };

    try {
      const stream = (await docker.getEvents({
        filters: {
          type: ['container'],
          event: ['start'],
          label: [`${LabelPrefix.COMPOSE}.service=${proxyServiceName}`],
        },
      })) as unknown as Readable;

      cell.set('stream', stream);
      stream.on('data', onEvents);
      stream.on('error', (error: unknown) => {
        logger.warn(
          { error },
          '[proxy-error-pages] Docker events stream failed',
        );
        reconnect();
      });
      stream.on('end', reconnect);
      stream.on('close', reconnect);
    } catch (error) {
      logger.warn(
        { error },
        '[proxy-error-pages] could not watch Docker events',
      );
      reconnect();
    }
  };

  connect().catch(() => undefined);

  return {
    stop: () => {
      cell.set('stopped', true);
      const pendingTimer = timer();

      if (pendingTimer) {
        clearTimeout(pendingTimer);
      }

      (cell.get('stream') as Readable | undefined)?.destroy();
    },
  };
};

export default watchProxyStartEvents;
