import fastify from 'fastify';

const fastifyLogger: boolean = process.env.DEBUG === 'true';
const port: number = 50000;

const server = fastify({
  logger: fastifyLogger,
});

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

// Run the server!
const start = async () => {
  try {
    await server.listen({ host: '0.0.0.0', port });

    console.log(`Server started on port ${port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
