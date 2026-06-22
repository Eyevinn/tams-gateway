import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { FastifyPluginCallback } from 'fastify';
import fastifyStatic from '@fastify/static';

// Built-in read-only inspector UI (ADR-007). Registered ONLY when ENABLE_UI is
// on (see api.ts). Serves the hand-written static assets in ../../ui as /ui and
// /ui/*. No build/bundler step: the assets are plain files committed under src/
// and the Docker image already copies all of src/, so they ship as-is. The
// static root is resolved relative to THIS module's location (import.meta.url),
// not the process cwd, so it works under tsx, a future tsc build, and `npm
// start` alike.
//
// Read-only by construction (ADR-007 D3): this only serves static files; the
// client bundle (inspector.js) issues GET-only requests. No mutating route is
// added here.

const moduleDir = dirname(fileURLToPath(import.meta.url));
// src/api/endpoints/ui -> src/api/ui
const UI_ROOT = join(moduleDir, '..', '..', 'ui');

const ui: FastifyPluginCallback = (fastify, _, next) => {
  fastify.register(fastifyStatic, {
    root: UI_ROOT,
    prefix: '/ui/',
    index: ['index.html'],
    // The inspector is not public; it rides the deployment's own auth (ADR-007
    // D5). Cache-busting: the inspector is iterated on and redeployed, so its
    // assets must never go stale in the browser. "no-cache" forces revalidation;
    // the ETag still yields cheap 304s when the bytes are unchanged.
    cacheControl: false,
    setHeaders: function (res) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  });

  // Bare /ui (no trailing slash) -> serve the index so a browser hitting /ui
  // lands on the flows list. ignoreTrailingSlash handles the redirect shape but
  // we send the file directly to guarantee a 200 text/html on /ui exactly.
  fastify.get('/ui', (_req, reply) => {
    reply.header('Cache-Control', 'no-cache');
    return reply.sendFile('index.html', UI_ROOT);
  });

  next();
};

export default ui;
