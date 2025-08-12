import fastify from 'fastify';
import Docker from 'dockerode';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUI from '@fastify/swagger-ui';

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

declare module 'fastify' {
  interface FastifyInstance {
    docker: Docker;
    gluesyncSdk: any;
    swagger: (opts?: { yaml?: boolean; transform?: any }) => any;
  }
}

const port: number = process.env.PORT ? parseInt(process.env.PORT, 10) : 50000;
const host: string = process.env.HOST || '0.0.0.0';

async function startServer() {
  const serverOptions = createFastifyHttpsOptions();
  const server = fastify(serverOptions);

  logSslInfo();
  httpsRedirectMiddleware(server);

  // Register Swagger plugins first
  await server.register(fastifySwagger, {
    openapi: {
      openapi: '3.0.0',
      info: {
        title: 'Gluesync Conductor API',
        description: 'API documentation for Gluesync Conductor',
        version: '1.0.0',
      },
      servers: [
        {
          url: `http://localhost:${port}`,
          description: 'Development server',
        },
      ],
      tags: [
        { name: 'system', description: 'System related endpoints' },
        { name: 'containers', description: 'Container related endpoints' },
        { name: 'agents', description: 'Agent related endpoints' },
      ],
      components: {
        securitySchemes: {
          apiKey: {
            type: 'apiKey',
            name: 'apiKey',
            in: 'header',
          },
        },
      },
    },
  });

  await server.register(fastifySwaggerUI, {
    routePrefix: '/docs',
  });

  // Register other plugins
  await server.register(dockerPlugin);
  await server.register(gluesyncPlugin);

  // Register route modules
  await server.register(systemRoutes);
  await server.register(containerRoutes);
  await server.register(agentRoutes);

  // Add OpenAPI JSON endpoint
  server.get('/openapi.json', async (request, reply) => {
    return server.swagger();
  });

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
}

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
