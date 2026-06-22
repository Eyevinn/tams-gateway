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
  // When the inspector UI is enabled, a browser hitting the root is redirected
  // to it for minimal friction (ADR-007). Pure content negotiation: only an
  // Accept that explicitly prefers HTML is redirected, so API clients, the OSC
  // gate health probe, and conformance tooling (which send JSON / star-star)
  // still get the unchanged JSON root-paths response.
  enableUi?: boolean;
}

const healthcheck: FastifyPluginCallback<HealthcheckOptions> = (
  fastify,
  opts,
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
    async (request, reply) => {
      // Minimal-friction landing: a browser (Accept prefers text/html) is sent
      // to the inspector when it is enabled. Everything else (application/json,
      // */*, no Accept) gets the unchanged JSON root-paths response, so the API
      // contract, the liveness probe, and conformance tooling are untouched.
      if (
        opts.enableUi &&
        (request.headers.accept ?? '').includes('text/html')
      ) {
        return reply.redirect('/ui');
      }
      reply.send(ROOT_PATHS);
    }
  );
  next();
};

export default healthcheck;
