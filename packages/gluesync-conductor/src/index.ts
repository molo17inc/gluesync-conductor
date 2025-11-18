import fastify from 'fastify';
import cors from '@fastify/cors';
import Docker from 'dockerode';
import dockerPlugin from './plugins/docker';
import swaggerPlugin from './plugins/swagger';
import gluesyncPlugin from './plugins/gluesync';
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
import autoAdoptServices from './helpers/autoAdoptServices/autoAdoptServices';

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

const startServer = async () => {
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

  // Register route modules
  await server.register(systemRoutes);
  await server.register(serviceRoutes);
  await server.register(containerRoutes);
  await server.register(agentRoutes);
  await server.register(supportRoutes);

  await server.ready();
  await server.listen({ host, port });

  const protocol = isSslEnabled() ? 'https' : 'http';
  console.info(
    `Swagger UI is available at ${protocol}://${host === '0.0.0.0' ? 'localhost' : host}:${port}/docs`,
  );
  console.info(
    `OpenAPI JSON available at ${protocol}://${host === '0.0.0.0' ? 'localhost' : host}:${port}/openapi.json`,
  );
  console.info(`Gluesync Conductor server started on port ${port}`);

  const result = await autoAdoptServices();
  if (result.success) {
    if (result.updatedIds.length > 0) {
      console.info(
        `Applied conductor labels to services: ${result.updatedIds.join(', ')}`,
      );
    }
  } else {
    console.warn('Failed to apply conductor labels at startup');
  }
};

// Handle unhandled rejections
process.on('unhandledRejection', err => {
  console.error('Unhandled Promise Rejection:', err);
  process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', err => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

// Start the fastify server
startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
