import { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import Docker from 'dockerode';

const dockerPlugin = async (fastify: FastifyInstance) => {
  const docker = new Docker();

  fastify.decorate('docker', docker);
};

export default fp(dockerPlugin);
