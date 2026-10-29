import fastify from 'fastify';
import cors from '@fastify/cors';
import Docker from 'dockerode';

import dockerPlugin from './plugins/docker';
import swaggerPlugin from './plugins/swagger';
import gluesyncPlugin from './plugins/gluesync';
import apiBlockerAsUpdatingPlugin, {
  disableUpdateMode,
} from './plugins/apiBlockerAsUpdating';
import tzFix from './plugins/tzFix';
import fakeErrorInjectorPlugin from './plugins/fakeErrorInjector';

import httpsRedirectMiddleware from './middleware/httpsRedirect';
import { authPlugin } from './security';

import {
  createFastifyHttpsOptions,
  isSslEnabled,
  logSslInfo,
} from './utils/ssl';

import systemRoutes from './routes/system';
import containerRoutes from './routes/containers';
import agentRoutes from './routes/agents';
import serviceRoutes from './routes/services';
import supportRoutes from './routes/support';

import { getLogger, logFatalAndExit } from './utils/logger';
import autoAdoptServices from './helpers/autoAdoptServices/autoAdoptServices';
import { autoReboot } from './helpers/autoReboot/autoReboot';
import getRootPath from './helpers/getRootPath/getRootPath';
import healConductorConf from './helpers/healConductorConf/healConductorConf';
import syncCollectLogsScripts from './helpers/syncCollectLogsScripts/syncCollectLogsScripts';
import upAdoptedServices from './helpers/upAdoptedServices/upAdoptedServices';
import healProxyErrorPages from './helpers/healProxyErrorPages/healProxyErrorPages';
import watchProxyStartEvents from './helpers/healProxyErrorPages/watchProxyStartEvents';
import { findProxyServiceName } from './helpers/healTraefikConf/healTraefikConf';
import { readComposeFile } from './helpers/composeFile/readComposeFile/readComposeFile';
import { isContainerActionRunning } from './functions/container/doContainersAction/doContainersAction';
import migrateRoutes from './routes/migrate';
import envRoutes from './routes/env';
import updateModeEmitter from './plugins/updateModeEmitter';
import { startUpdateWatchdog } from './helpers/updateWatchdog/updateWatchdog';

type FastifyServices = {
  docker: Docker;
  gluesyncSdk: any;
};

type FastifyMethods = {
  swagger: (opts?: Readonly<{ yaml?: boolean; transform?: any }>) => any;
};

declare module 'fastify' {
  interface FastifyInstance extends FastifyServices, FastifyMethods {}
}

const port: number = process.env.PORT ? parseInt(process.env.PORT, 10) : 50000;
const host: string = process.env.HOST || '0.0.0.0';

/*
  We use a Map to hold the watchdog-running boolean.
*/
const watchdogCell = new Map<string, boolean>([['value', false]]);

// After the adoption: this step reads and writes the compose file afterwards.
// A failure here is logged and startup goes on; a failed heal still leaves the
// start-event trigger running.
const healProxyErrorPagesAtStartup = async (
  docker: Readonly<Docker>,
): Promise<void> => {
  try {
    await healProxyErrorPages({ reason: 'startup' });
  } catch (error) {
    getLogger().error(
      { error },
      '[proxy-error-pages] startup heal failed, going on',
    );
  }

  try {
    const proxyServiceName = findProxyServiceName(
      await readComposeFile({ raw: true }),
    );

    if (proxyServiceName) {
      watchProxyStartEvents({
        docker,
        proxyServiceName,
        isBusy: isContainerActionRunning,
      });
    }
  } catch (error) {
    getLogger().error(
      { error },
      '[proxy-error-pages] could not start the proxy event watcher, going on',
    );
  }
};

const startServer = async (): Promise<void> => {
  const serverOptions = createFastifyHttpsOptions();
  const server = fastify(serverOptions);
  const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true';

  // Register TZ fix FIRST (so later plugins/routes see the normalized TZ for windows).
  if (isWindows) {
    await server.register(tzFix, {
      fallbackIana: undefined,
      log: true,
    });
  }

  const logger = getLogger();

  logSslInfo();
  httpsRedirectMiddleware(server);

  // Register CORS before routes
  await server.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // Register Swagger plugins first
  await server.register(swaggerPlugin);

  // Register Docker plugin
  await server.register(dockerPlugin);

  // Register Gluesync plugin
  await server.register(gluesyncPlugin);

  // Register auth plugin (after gluesync so CoreHub URL is available, before routes)
  await server.register(authPlugin);

  // Register api blocker when updating plugin, routes after this will be blocked when updating
  await server.register(apiBlockerAsUpdatingPlugin, {
    statusCode: 503,
    message: 'Conductor is updating. Try again later',
    bypassPaths: ['/containers', '/collect-logs'],
    bypassMethods: ['POST'],
  });

  // DEBUG ONLY: fake OTA failures and available updates so the UI can be tried. Not registered unless
  // GLUESYNC_FAKE_ERROR is set (see plugins/fakeErrorInjector.ts).
  if (process.env.GLUESYNC_FAKE_ERROR) {
    await server.register(fakeErrorInjectorPlugin);
  }

  // Register route modules
  const onUpdateEnabled = async (): Promise<void> => {
    if (watchdogCell.get('value') ?? false) {
      getLogger().info(
        '[watchdog] watchdog already running, ignoring duplicate updateModeEnabled event',
      );
      return;
    }

    watchdogCell.set('value', true);

    getLogger().info(
      '[watchdog] update mode enabled event received — starting watchdog',
    );

    try {
      const result = await startUpdateWatchdog(server.docker, {
        serviceName: process.env.CONDUCTOR_NAME || 'gluesync-conductor',
        helperImageOrName: process.env.HELPER_IMAGE_BASE || undefined,
        pollIntervalMs: 5000,
        timeoutMs: 5 * 60 * 1000,
        updateModeGraceMs: 45_000,
        recoveryFunction: async (serviceName: string) => {
          try {
            await autoReboot({
              hostProjectDir: getRootPath({ basePath: process.env.BASE_PATH }),
              serviceName,
              helperImage:
                process.env.IS_WINDOWS?.toLowerCase() === 'true'
                  ? process.env.HELPER_IMAGE_BASE || ''
                  : 'docker:cli',
              log: msg => getLogger().info({ msg }, '[watchdog-recovery]'),
            });
            return true;
          } catch (error) {
            getLogger().error(
              { error },
              '[watchdog-recovery] autoReboot failed',
            );
            return false;
          }
        },
      });

      if (result.ok) {
        getLogger().info(
          { reason: result.reason },
          '[watchdog] service healthy or recovered — disabling update mode',
        );
        disableUpdateMode();
      } else {
        getLogger().error(
          { reason: result.reason },
          '[watchdog] watchdog failed/timed out — disabling update mode to avoid permanent lock',
        );
        disableUpdateMode();
      }
    } catch (error) {
      getLogger().error({ error }, '[watchdog] unexpected error');
      disableUpdateMode();
    } finally {
      watchdogCell.set('value', false);
    }
  };

  const onUpdateDisabled = (): void => {
    getLogger().info('[watchdog] update mode disabled event received');
  };

  updateModeEmitter.on('updateModeEnabled', onUpdateEnabled);
  updateModeEmitter.on('updateModeDisabled', onUpdateDisabled);

  // Remove listeners on server close to avoid leaks
  server.addHook('onClose', async () => {
    updateModeEmitter.off('updateModeEnabled', onUpdateEnabled);
    updateModeEmitter.off('updateModeDisabled', onUpdateDisabled);
  });

  await server.register(systemRoutes);
  await server.register(serviceRoutes);
  await server.register(containerRoutes);
  await server.register(agentRoutes);
  await server.register(supportRoutes);
  await server.register(migrateRoutes);
  await server.register(envRoutes);

  await server.ready();
  await server.listen({ host, port });

  const protocol = isSslEnabled() ? 'https' : 'http';
  logger.info(
    `Swagger UI is available at ${protocol}://${host === '0.0.0.0' ? 'localhost' : host}:${port}/docs`,
  );
  logger.info(
    `OpenAPI JSON available at ${protocol}://${host === '0.0.0.0' ? 'localhost' : host}:${port}/openapi.json`,
  );
  logger.info(`Gluesync Conductor server started on port ${port}`);

  const result = await autoAdoptServices();

  if (result.success) {
    const { updatedIds, unmatchedIds } = result;

    if (updatedIds.length === 0 && unmatchedIds.length === 0) {
      logger.info(
        'All services already had a Conductor type, no changes applied',
      );
    } else if (updatedIds.length > 0) {
      logger.info(
        `Applied Conductor labels to services: ${updatedIds.join(', ')}`,
      );

      if (unmatchedIds.length > 0) {
        logger.warn(
          `Some services had no Conductor type and did not match agents.json: ${unmatchedIds.join(', ')}`,
        );
      }

      // Start only the adopted/updated services (Linux + Windows)
      await upAdoptedServices(server.docker, updatedIds);
    } else if (updatedIds.length === 0 && unmatchedIds.length > 0) {
      logger.warn(
        `No services adopted. Unmatched services: ${unmatchedIds.join(', ')}`,
      );
    }
  } else {
    logger.error('Failed to apply Conductor labels at startup');
  }

  await healProxyErrorPagesAtStartup(server.docker);

  const syncResult = await syncCollectLogsScripts();

  if (syncResult.synced) {
    logger.info('[collect-logs-sync] script synced to root folder');
  } else if (syncResult.success) {
    logger.info('[collect-logs-sync] already up to date');
  } else {
    logger.warn('[collect-logs-sync] sync failed');
  }

  const rebootNeeded = await healConductorConf();

  logger.info(
    `[conductor-healer] ${rebootNeeded ? 'reboot needed to heal' : 'nothing to heal'}`,
  );

  const helperImageWindows = process.env.HELPER_IMAGE_BASE || '';

  if (rebootNeeded) {
    const shouldUseWindows =
      process.env.IS_WINDOWS?.toLowerCase() === 'true' || false;

    autoReboot({
      hostProjectDir: getRootPath({ basePath: process.env.BASE_PATH }),
      serviceName: 'gluesync-conductor',
      helperImage: shouldUseWindows ? helperImageWindows : 'docker:cli',
      log: msg => logger.info({ msg }, '[conductor-healer] self-heal log'),
    });
  }
};

// Handle unhandled rejections
process.on('unhandledRejection', (error: unknown) => {
  logFatalAndExit('Unhandled Promise Rejection', error);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error: unknown) => {
  logFatalAndExit('Uncaught Exception', error);
});

// Start the fastify server
startServer().catch((error: unknown) => {
  logFatalAndExit('Failed to start server', error);
});
