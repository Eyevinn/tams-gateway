import { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import Logger from '../../utils/Logger';

export default (
  error: FastifyError,
  _: FastifyRequest,
  reply: FastifyReply
) => {
  const errorCode = error.statusCode ?? 500;
  const errorMessage = error.message ?? 'No Message';

  // Log error
  Logger.red(`[${errorCode}]: ${errorMessage}`);
  // Send error response
  reply.status(errorCode).send({ statusCode: errorCode, error: errorMessage });
};
