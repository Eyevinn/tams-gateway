import { FastifyPluginCallback } from 'fastify';
import { client } from '../../db/client';

// Readiness probe: verifies the gateway can reach CouchDB. Unlike the
// liveness healthcheck at `/`, this returns 503 when the database is
// unavailable so an orchestrator does not route traffic to a broken instance.
const readiness: FastifyPluginCallback = (fastify, _, next) => {
  fastify.get(
    '/readiness',
    {
      schema: {
        tags: ['Healthcheck'],
        description: 'Readiness probe (checks database connectivity)'
      }
    },
    async (_request, reply) => {
      try {
        await client.db.list();
        reply.code(200).send({ status: 'ready' });
      } catch {
        reply.code(503).send({ status: 'unavailable' });
      }
    }
  );
  next();
};

export default readiness;
