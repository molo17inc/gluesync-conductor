import { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';

/**
 * This plugin integrates Swagger documentation with Fastify
 */
async function swaggerPlugin(fastify: FastifyInstance) {
  // Get the path to the swagger.yaml file
  const swaggerPath = path.join(__dirname, '../../../../swagger.yaml');
  
  // Check if swagger.yaml exists
  if (!fs.existsSync(swaggerPath)) {
    fastify.log.warn('swagger.yaml not found at: ' + swaggerPath);
    return;
  }

  // Read and parse the swagger.yaml file
  const yamlContent = fs.readFileSync(swaggerPath, 'utf8');
  const swaggerDocument = yaml.parse(yamlContent);

  // Register Swagger
  await fastify.register(import('@fastify/swagger'), {
    swagger: swaggerDocument,
    hideUntagged: false
  });

  // Register Swagger UI
  await fastify.register(import('@fastify/swagger-ui'), {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true
    },
    transformSpecification: (swaggerObject) => {
      return swaggerObject;
    },
    staticCSP: true
  });

  fastify.log.info('Swagger UI available at /docs');
}

export default fp(swaggerPlugin);
