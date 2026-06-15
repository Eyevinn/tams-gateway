import { FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual } from 'crypto';

// Paths that stay public so orchestrators (liveness/readiness probes) and
// humans (API docs) can reach them without a token.
const isPublicPath = (url: string): boolean => {
  const path = url.split('?')[0];
  return (
    path === '/' ||
    path === '/readiness' ||
    path === '/docs' ||
    path.startsWith('/docs/')
  );
};

// Constant-time comparison to avoid leaking the token via response timing.
const matches = (provided: string, expected: string): boolean => {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

// Bearer-token authentication hook. Enabled only when a token is configured;
// public paths and CORS preflight (OPTIONS) requests bypass it.
export const createAuthHook =
  (token: string) =>
  async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (request.method === 'OPTIONS' || isPublicPath(request.url)) {
      return;
    }
    const header = request.headers.authorization ?? '';
    if (!matches(header, `Bearer ${token}`)) {
      reply.code(401).send({ error: 'Unauthorized' });
    }
  };
