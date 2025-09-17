import fastify from 'fastify';
import cors from '@fastify/cors'; // <-- add this
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

  // ✅ Register CORS before routes
  await server.register(cors, {
    origin: (
      origin: Readonly<string>,
      cb: (err: Readonly<Error | null>, allow?: Readonly<boolean>) => void,
    ) => {
      const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') ?? [];

      if (!origin) return cb(null, true); // allow non-browser clients
      if (allowedOrigins.includes(origin)) {
        return cb(null, true);
      }
      return cb(new Error('Not allowed by CORS'), false);
    },
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
  await server.register(containerRoutes);
  await server.register(agentRoutes);

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
