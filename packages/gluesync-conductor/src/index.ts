import fastify from 'fastify';
import cors from '@fastify/cors';
import Docker from 'dockerode';
import dockerPlugin from './plugins/docker';
import swaggerPlugin from './plugins/swagger';
import gluesyncPlugin from './plugins/gluesync';
import apiBlockerAsUpdatingPlugin from './plugins/apiBlockerAsUpdating';
import httpsRedirectMiddleware from './middleware/httpsRedirect';
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
import { getLogger } from './utils/logger';
import autoAdoptServices from './helpers/autoAdoptServices/autoAdoptServices';
import { autoReboot } from './helpers/autoReboot/autoReboot';
import getRootPath from './helpers/getRootPath/getRootPath';
import healConductorConf from './helpers/healConductorConf/healConductorConf';

type FastifyServices = {
  docker: Docker;
  gluesyncSdk: any;
};

type FastifyMethods = {
  swagger: (opts?: Readonly<{ yaml?: boolean; transform?: any }>) => any;
};

declare module 'fastify' {
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface FastifyInstance extends FastifyServices, FastifyMethods {}
}

const port: number = process.env.PORT ? parseInt(process.env.PORT, 10) : 50000;
const host: string = process.env.HOST || '0.0.0.0';

const startServer = async () => {
  const logger = getLogger();
  const serverOptions = createFastifyHttpsOptions();
  const server = fastify(serverOptions);

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

  // Register api blocker when updating plugin, routes after this will be blocked when updating
  await server.register(apiBlockerAsUpdatingPlugin, {
    statusCode: 503,
    message: 'Conductor is updating.',
  });

  // Register route modules
  await server.register(systemRoutes);
  await server.register(serviceRoutes);
  await server.register(containerRoutes);
  await server.register(agentRoutes);
  await server.register(supportRoutes);

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
      // Nothing changed because all services already had a type
      logger.info(
        'All services already had a Conductor type, no changes applied',
      );
    } else if (updatedIds.length > 0) {
      // Some services adopted (with or without unmatched ones)
      logger.info(
        `Applied Conductor labels to services: ${updatedIds.join(', ')}`,
      );

      if (unmatchedIds.length > 0) {
        logger.warn(
          `Some services had no Conductor type and did not match agents.json: ${unmatchedIds.join(', ')}`,
        );
      }
    } else if (updatedIds.length === 0 && unmatchedIds.length > 0) {
      // Edge case: no adoption, only unmatched
      logger.warn(
        `No services adopted. Unmatched services: ${unmatchedIds.join(', ')}`,
      );
    }
  } else {
    // Nothing adopted because of an error
    logger.error('Failed to apply Conductor labels at startup');
  }

  const rebootNeeded = await healConductorConf();

  if (rebootNeeded) {
    autoReboot({
      hostProjectDir: getRootPath({ basePath: process.env.BASE_PATH }),
      serviceName: 'gluesync-conductor',
      helperImage: 'docker:cli',
      log: msg => logger.info({ msg }, '[conductor-updater] self-heal log'),
    });
  }
};

// Handle unhandled rejections
process.on('unhandledRejection', err => {
  getLogger().error({ err }, 'Unhandled Promise Rejection');
  process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', err => {
  getLogger().error({ err }, 'Uncaught Exception');
  process.exit(1);
});

// Start the fastify server
startServer().catch(err => {
  getLogger().error({ err }, 'Failed to start server');
  process.exit(1);
});
