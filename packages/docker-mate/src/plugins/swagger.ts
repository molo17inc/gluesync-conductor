import fp from 'fastify-plugin';
import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUI from '@fastify/swagger-ui';
import path from 'path';
import fs from 'fs';

const swaggerPlugin: FastifyPluginAsync = async (
  fastify: Readonly<FastifyInstance>,
) => {
  const staticPath = path.join(__dirname, 'static');
  const hasStaticDir = fs.existsSync(staticPath);
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 50000;

  await fastify.register(fastifySwagger, {
    mode: 'dynamic',
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

  await fastify.register(fastifySwaggerUI, {
    routePrefix: '/docs',
    baseDir: hasStaticDir ? staticPath : undefined, // Relative to index.js (in build)
    // staticCSP: true,                                     // not needed because it runs locally
    // transformStaticCSP: (header: string) => header,      // if there is the need to change the header
  });

  fastify.get('/openapi.json', async () => fastify.swagger());
};

export default fp(swaggerPlugin);
