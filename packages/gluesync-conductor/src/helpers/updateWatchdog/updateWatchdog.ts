import Docker from 'dockerode';
import stream from 'stream';
import { getLogger } from '../../utils/logger';
import { readComposeFile } from '../composeFile/readComposeFile/readComposeFile';
import parseImage from '../parseImage/parseImage';
import {
  disableUpdateMode,
  isUpdateMode,
} from '../../plugins/apiBlockerAsUpdating';
import getCurrentVersion from '../getCurrentVersion/getCurrentVersion';
import {
  HealthStatus,
  ParsedImage,
  PollWatchdog,
  RuntimeValidationResult,
  StartUpdateWatchdog,
} from './updateWatchdog.model';

const sleep = async (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

const logger = getLogger();

const normalizeVersion = (version: string | null): string | null =>
  version ? version.trim() : null;

export const getServiceImage = async (
  serviceName: string,
): Promise<ParsedImage | undefined> => {
  try {
    const composeJson = await readComposeFile();
    const service = composeJson.services?.[serviceName];

    if (!service) {
      logger.warn(
        { serviceName },
        '[watchdog] service not found in compose file',
      );
      return undefined;
    }

    if (typeof service.image !== 'string' || service.image.trim() === '') {
      logger.info(
        { serviceName },
        '[watchdog] service has no image field in compose file',
      );
      return undefined;
    }

    return parseImage(service.image);
  } catch (error) {
    logger.warn(
      { error, serviceName },
      '[watchdog] failed to resolve service image',
    );
    return undefined;
  }
};

export const imageExists = async (
  docker: Readonly<Docker>,
  imageTag: string,
): Promise<boolean> => {
  try {
    const image = docker.getImage(imageTag);
    await image.inspect();
    return true;
  } catch {
    return false;
  }
};

export const helperRunning = async (
  docker: Readonly<Docker>,
  helperImageOrName: string,
): Promise<boolean> => {
  try {
    const byAncestor = await docker.listContainers({
      filters: { ancestor: [helperImageOrName] },
    });

    if (byAncestor.length > 0) {
      return true;
    }

    const byName = await docker.listContainers({
      all: true,
      filters: { name: [helperImageOrName] },
    });

    return byName.length > 0;
  } catch {
    return false;
  }
};

export const recentPullEvents = async (
  docker: Readonly<Docker>,
  secondsWindow = 30,
  listenMs = 3000,
): Promise<boolean> => {
  try {
    const since = Math.floor(Date.now() / 1000) - secondsWindow;

    const maybeStream = docker.getEvents({
      since,
      filters: { event: ['pull'] },
    });

    const eventsStream = (await Promise.resolve(
      maybeStream,
    )) as stream.Readable;

    const detectionPromise = new Promise<boolean>((resolve, reject) => {
      const onData = (chunk: Buffer): void => {
        const text = chunk.toString('utf8').trim();

        text.split(/\r?\n/).forEach(line => {
          if (!line) {
            return;
          }

          try {
            const obj = JSON.parse(line) as
              | Readonly<{ Action?: string; action?: string }>
              | undefined;

            if (obj && (obj.Action === 'pull' || obj.action === 'pull')) {
              resolve(true);
            }
          } catch (error) {
            logger.debug({ error }, '[watchdog] ignored event parse error');
          }
        });
      };

      const onEnd = (): void => {
        resolve(false);
      };

      const onClose = (): void => {
        resolve(false);
      };

      const onError = (error: Readonly<Error>): void => {
        reject(error);
      };

      eventsStream.on('data', onData);
      eventsStream.on('end', onEnd);
      eventsStream.on('close', onClose);
      eventsStream.on('error', onError);
    });

    const timeoutPromise = new Promise<boolean>(resolve => {
      setTimeout(() => {
        resolve(false);
      }, listenMs);
    });

    const result = await Promise.race([detectionPromise, timeoutPromise]);

    try {
      (eventsStream as { destroy?: () => void }).destroy?.();
    } catch (error) {
      logger.debug({ error }, '[watchdog] ignored stream destroy error');
    } finally {
      try {
        eventsStream.removeAllListeners('data');
        eventsStream.removeAllListeners('end');
        eventsStream.removeAllListeners('close');
        eventsStream.removeAllListeners('error');
      } catch {
        // ignore
      }
    }

    return result;
  } catch (error) {
    logger.debug({ error }, '[watchdog] recentPullEvents failed');
    return false;
  }
};

export const isPullInProgress = async (
  docker: Readonly<Docker>,
  serviceName: string,
  helperImageOrName?: string,
): Promise<boolean> => {
  const parsedImage = await getServiceImage(serviceName);

  if (
    parsedImage?.original &&
    !(await imageExists(docker, parsedImage.original))
  ) {
    return true;
  }

  if (helperImageOrName && (await helperRunning(docker, helperImageOrName))) {
    return true;
  }

  try {
    return await recentPullEvents(docker, 120, 8000);
  } catch (error) {
    logger.debug(
      { error },
      '[watchdog] isPullInProgress recentPullEvents error',
    );
    return false;
  }
};

const validateRuntimeState = async (
  docker: Readonly<Docker>,
  serviceName: string,
): Promise<RuntimeValidationResult> => {
  try {
    const composeJson = await readComposeFile();
    const service = composeJson.services?.[serviceName];

    if (!service?.image) {
      return {
        ok: true,
        action: 'ok',
        reason: 'ok',
      };
    }

    const { tag: composeTag } = parseImage(service.image);

    const runningVersion = await getCurrentVersion(
      docker,
      composeJson,
      serviceName,
      true,
    );

    const expected = normalizeVersion(composeTag);
    const actual = normalizeVersion(runningVersion);

    if (expected !== actual) {
      logger.warn(
        {
          serviceName,
          expected,
          actual,
        },
        '[watchdog] version mismatch detected',
      );

      return {
        ok: false,
        action: 'recover',
        reason: 'version-mismatch',
      };
    }

    const imagePresent = await imageExists(docker, service.image);

    if (!imagePresent) {
      logger.warn(
        {
          serviceName,
          image: service.image,
        },
        '[watchdog] expected image missing locally',
      );

      return {
        ok: false,
        action: 'poll',
        reason: 'pull-in-progress',
      };
    }

    return {
      ok: true,
      action: 'ok',
      reason: 'ok',
    };
  } catch (error) {
    logger.warn({ error, serviceName }, '[watchdog] runtime validation failed');

    return {
      ok: false,
      action: 'recover',
      reason: 'validation-error',
    };
  }
};

export const getContainerByServiceName = async (
  docker: Readonly<Docker>,
  serviceName: string,
): Promise<Docker.ContainerInfo | undefined> => {
  const list = await docker.listContainers({
    all: true,
    filters: { label: [`com.docker.compose.service=${serviceName}`] },
  });

  return list.length > 0 ? list[0] : undefined;
};

export const getContainerHealthStatus = async (
  docker: Readonly<Docker>,
  containerIdOrName: string,
): Promise<HealthStatus> => {
  try {
    const container = docker.getContainer(containerIdOrName);
    const info = await container.inspect();
    const running = Boolean(info?.State?.Running);
    const healthRaw = info?.State?.Health?.Status;
    const health = healthRaw
      ? (healthRaw as 'healthy' | 'unhealthy' | 'starting')
      : 'none';

    return { running, health };
  } catch {
    return { running: false, health: 'none' };
  }
};

const attemptRecoverRecursive = async (
  serviceName: string,
  recoveryFn: (serviceName: string) => Promise<boolean>,
  attempt: number,
  maxAttempts: number,
): Promise<boolean> => {
  try {
    const ok = await recoveryFn(serviceName);

    if (!ok) {
      throw new Error('recoveryFn failed');
    }

    return true;
  } catch (error) {
    const msg = String(error instanceof Error ? error.message : error);

    if (msg.includes('No such image: sha256') && attempt < maxAttempts) {
      const backoff = 5000 * attempt;
      logger.warn(
        { msg, attempt, backoff },
        '[watchdog] transient digest error, backing off',
      );
      await sleep(backoff);

      return attemptRecoverRecursive(
        serviceName,
        recoveryFn,
        attempt + 1,
        maxAttempts,
      );
    }

    throw error;
  }
};

export const attemptRecover = async (
  serviceName: string,
  recoveryFn?: (serviceName: string) => Promise<boolean>,
  maxAttempts = 3,
): Promise<boolean> => {
  if (!recoveryFn) {
    return false;
  }

  return attemptRecoverRecursive(serviceName, recoveryFn, 1, maxAttempts);
};

const pollWatchdog: PollWatchdog = async (docker, opts, state) => {
  const {
    serviceName,
    helperImageOrName,
    pollIntervalMs = 5000,
    timeoutMs = 5 * 60 * 1000,
    updateModeGraceMs = 10_000,
    recoveryFunction,
  } = opts;

  // 1. Exit Condition: Update mode disabled
  if (!isUpdateMode()) {
    logger.info(
      { serviceName },
      '[watchdog] update mode is not active, stopping watchdog',
    );
    return { ok: true, reason: 'update-mode-disabled' };
  }

  // 2. Exit Condition: Timeout
  const now = Date.now();
  if (now - state.startMs >= timeoutMs) {
    return { ok: false, reason: 'timeout' };
  }

  const containerInfo = await getContainerByServiceName(docker, serviceName);
  const containerIdOrName = containerInfo ? containerInfo.Id : serviceName;
  const status = await getContainerHealthStatus(docker, containerIdOrName);

  // --- BRANCH: Container is RUNNING ---
  if (status.running) {
    const validation = await validateRuntimeState(docker, serviceName);

    logger.info(
      {
        serviceName,
        running: status.running,
        health: status.health,
        validation,
      },
      '[watchdog] running-state evaluation',
    );

    if (validation.ok) {
      if (status.health === 'healthy') {
        await sleep(1500);
        logger.info(
          { serviceName },
          '[watchdog] service healthy or recovered — disabling update mode',
        );
        disableUpdateMode();
        return { ok: true, reason: 'healthy' };
      }

      if (status.health === 'none' || status.health === undefined) {
        logger.info(
          { serviceName },
          '[watchdog] running without healthcheck but runtime validated — disabling update mode',
        );
        disableUpdateMode();
        return { ok: true, reason: 'running-validated-no-healthcheck' };
      }

      // Still starting or healthy-ish, wait and recurse
      await sleep(pollIntervalMs);
      return pollWatchdog(docker, opts, state);
    }

    if (validation.reason === 'pull-in-progress') {
      await sleep(pollIntervalMs);
      return pollWatchdog(docker, opts, state);
    }

    if (validation.reason === 'version-mismatch') {
      const firstNotRunningAt = state.firstNotRunningAt ?? now;
      const staleForMs = now - firstNotRunningAt;

      if (staleForMs < updateModeGraceMs) {
        logger.info(
          { serviceName, staleForMs, updateModeGraceMs },
          '[watchdog] version mismatch detected but still within grace window',
        );
        await sleep(pollIntervalMs);
        return pollWatchdog(docker, opts, { ...state, firstNotRunningAt });
      }

      if (recoveryFunction) {
        logger.warn(
          { serviceName, staleForMs },
          '[watchdog] running stale version after grace window, attempting recovery',
        );
        await attemptRecover(serviceName, recoveryFunction);
        await sleep(pollIntervalMs);
        return pollWatchdog(docker, opts, {
          ...state,
          firstNotRunningAt,
          recoveryAttempts: state.recoveryAttempts + 1,
        });
      }
    }

    if (recoveryFunction) {
      logger.warn(
        { serviceName, reason: validation.reason },
        '[watchdog] runtime validation failed, attempting recovery',
      );
      await attemptRecover(serviceName, recoveryFunction);
      await sleep(pollIntervalMs);
      return pollWatchdog(docker, opts, {
        ...state,
        recoveryAttempts: state.recoveryAttempts + 1,
      });
    }

    await sleep(pollIntervalMs);
    return pollWatchdog(docker, opts, state);
  }

  // --- BRANCH: Container is NOT RUNNING ---
  const firstNotRunningAt = state.firstNotRunningAt ?? now;
  const downForMs = now - firstNotRunningAt;
  const withinGrace = downForMs < updateModeGraceMs;

  const pulling = await isPullInProgress(
    docker,
    serviceName,
    helperImageOrName,
  );

  if (pulling || withinGrace) {
    logger.debug(
      { downForMs, serviceName, pulling, withinGrace },
      '[watchdog] deferring recovery (pulling or within grace window)',
    );
    await sleep(pollIntervalMs);
    return pollWatchdog(docker, opts, { ...state, firstNotRunningAt });
  }

  if (!recoveryFunction) {
    await sleep(pollIntervalMs);
    return pollWatchdog(docker, opts, { ...state, firstNotRunningAt });
  }

  // Attempt Recovery
  try {
    const nextAttempts = state.recoveryAttempts + 1;
    logger.warn(
      { recoveryAttempts: nextAttempts, downForMs, serviceName },
      '[watchdog] service still down, attempting recovery',
    );

    const recovered = await attemptRecover(serviceName, recoveryFunction);

    if (recovered) {
      await sleep(5000);
      const postInfo = await getContainerByServiceName(docker, serviceName);
      const postStatus = await getContainerHealthStatus(
        docker,
        postInfo ? postInfo.Id : serviceName,
      );

      if (
        postStatus.running &&
        (postStatus.health === 'healthy' || postStatus.health === 'none')
      ) {
        return { ok: true, reason: 'recovered' };
      }
    }

    // Exponential-ish backoff
    await sleep(Math.min(pollIntervalMs * nextAttempts, 15000));
    return pollWatchdog(docker, opts, {
      ...state,
      firstNotRunningAt,
      recoveryAttempts: nextAttempts,
    });
  } catch (error) {
    const nextAttempts = state.recoveryAttempts + 1;
    logger.warn(
      { error, recoveryAttempts: nextAttempts, serviceName },
      '[watchdog] recovery attempt failed, continuing poll',
    );
    await sleep(Math.min(pollIntervalMs * nextAttempts, 15000));
    return pollWatchdog(docker, opts, {
      ...state,
      firstNotRunningAt,
      recoveryAttempts: nextAttempts,
    });
  }
};

export const startUpdateWatchdog: StartUpdateWatchdog = async (docker, opts) =>
  pollWatchdog(docker, opts, {
    startMs: Date.now(),
    firstNotRunningAt: undefined,
    recoveryAttempts: 0,
  });
