import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';

// Root endpoint: per the TAMS spec, GET / lists the API paths available from
// this service. It also doubles as a liveness check (always 200); readiness
// (DB/storage connectivity) is a separate probe at /readiness.
const RootPaths = Type.Array(Type.String());

// The root sub-paths this gateway implements.
const ROOT_PATHS = ['flows', 'sources'];

export interface HealthcheckOptions {
  title: string;
}

const healthcheck: FastifyPluginCallback<HealthcheckOptions> = (
  fastify,
  _opts,
  next
) => {
  fastify.get<{ Reply: Static<typeof RootPaths> }>(
    '/',
    {
      schema: {
        tags: ['Healthcheck'],
        description: 'List of paths available from this API',
        response: {
          200: RootPaths
        }
      }
    },
    async (_, reply) => {
      reply.send(ROOT_PATHS);
    }
  );
  next();
};

export default healthcheck;
