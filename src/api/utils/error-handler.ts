import { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import Logger from '../../utils/Logger';

export default (
  error: FastifyError,
  _: FastifyRequest,
  reply: FastifyReply
) => {
  const code = error.statusCode ?? 500;
  const message = error.message ?? 'No Message';

  // Log error
  Logger.red(`[${code}]: ${message}`);
  // Respond in the shape declared by ErrorResponse ({ code, message }) so the
  // wire format matches the documented schema.
  reply.status(code).send({ code, message });
};
