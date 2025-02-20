import fastify from 'fastify';
import Docker from 'dockerode';

import dockerPlugin from './plugins/docker';

import composeToJSON from './functions/composeToJSON/composeToJSON';
import info from './functions/info/info';
import version from './functions/version/version';
import listContainers from './functions/container/listContainers/listContainers';
import addAgent from './functions/agent/addAgent/addAgent';

declare module 'fastify' {
  interface FastifyInstance {
    docker: Docker;
  }
}

const fastifyLogger: boolean = process.env.DEBUG === 'true';
const port: number = 50000;

const server = fastify({
  logger: fastifyLogger,
});

server.register(dockerPlugin);

server.get('/health', async (req, reply) => {
  try {
    req.log.info('Health check OK!');
  } catch (error) {
    req.log.error('Error:', error);
    process.exit(1);
  }

  reply.statusCode = 200;
  reply.send({ success: true, data: 'Health check OK!' });
});

server.get('/compose-to-json', composeToJSON);
server.get('/info', info);
server.get('/version', version);
server.get('/containers', listContainers);

server.post('/agents/add', addAgent);

// Run the server!
const start = async () => {
  try {
    await server.listen({ host: '0.0.0.0', port });

    console.log(`Server started on port ${port}`);
  } catch (error) {
    server.log.error(`Start error: ${error}`);
    process.exit(1);
  }
};

start();
