import { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import fs from 'fs';
import path from 'path';

/**
 * This plugin integrates Swagger documentation with Fastify for the Gluesync Conductor API
 */
async function swaggerPlugin(fastify: Readonly<FastifyInstance>) {
  // Get the static Swagger file
  const swaggerFilePath = path.join(process.cwd(), 'swagger-static.json');
  const swaggerContent = JSON.parse(fs.readFileSync(swaggerFilePath, 'utf8'));

  // Register Swagger
  await fastify.register(import('@fastify/swagger'), {
    mode: 'static',
    specification: {
      document: swaggerContent,
    },
  });

  // Register Swagger UI
  await fastify.register(import('@fastify/swagger-ui'), {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
    staticCSP: true,
  });

  fastify.log.info('Swagger UI available at /docs');
}

export default fp(swaggerPlugin);
