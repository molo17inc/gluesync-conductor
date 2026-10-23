import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import fp from 'fastify-plugin';
import buildLocalErrorReply from '../diagnosis/buildLocalErrorReply';

/**
 * Catches what a route does not: a full disk or a corrupt compose file thrown
 * out of a handler gets its diagnosis instead of a bare 500. Every other error
 * goes on to Fastify's default handler, so validation errors keep their 400.
 */
const handleError = (
  error: Readonly<FastifyError>,
  req: Readonly<FastifyRequest>,
  reply: Readonly<FastifyReply>,
): void => {
  const local = buildLocalErrorReply(error);

  if (!local) {
    // Sent again from a custom handler, the error reaches the default one.
    reply.send(error);
    return;
  }

  req.log.error({ error }, '[local-error] request failed on this install');
  reply.code(local.statusCode).send(local.body);
};

const localErrorHandlerPlugin = (
  fastify: Readonly<FastifyInstance>,
  _opts: unknown,
  done: (err?: Readonly<Error>) => void,
): void => {
  fastify.setErrorHandler(handleError);
  done();
};

// Wrap with fastify-plugin so the handler applies to the routes registered after it
export default fp(localErrorHandlerPlugin, {
  name: 'local-error-handler',
  encapsulate: false,
});
