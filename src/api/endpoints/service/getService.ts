import { FastifyPluginCallback } from 'fastify';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// Single source of truth for the gateway's own version: package.json
// (resolveJsonModule is enabled). Distinct from api_version below, which is the
// TAMS spec version this gateway targets.
import { version as gatewayVersion } from '../../../../package.json';

// Image build timestamp, written to build-time.txt at the repo root by the
// Dockerfile at image build time. Read once at module load and advertised so
// the inspector UI footer can show "built <when>" without a hand-maintained
// constant. Absent in local dev (no Docker build) and in tests; any read error
// leaves it undefined and `build` is simply omitted from the descriptor.
const moduleDir = dirname(fileURLToPath(import.meta.url));
let buildStamp: string | undefined;
try {
  buildStamp =
    readFileSync(
      join(moduleDir, '../../../../build-time.txt'),
      'utf8'
    ).trim() || undefined;
} catch {
  buildStamp = undefined;
}

// Minimal TAMS service descriptor (service.json). Its purpose here is discovery:
// listing "webhooks" in event_stream_mechanisms is how a client learns this
// gateway supports the webhook endpoints (per the webhooks endpoint docs).
// Required fields per service.json: type, api_version, min_object_timeout.
const SERVICE = {
  name: 'TAMS Gateway',
  description:
    'Time-addressable Media Store (TAMS) gateway: indexes segmented media flows and serves presigned URLs.',
  type: 'urn:x-tams:service:tams-gateway',
  // The gateway's own release version (from package.json). NOT the spec version.
  version: gatewayVersion,
  // The TAMS API version this gateway targets (vendored spec tag).
  api_version: '8.1',
  // min_object_timeout / min_presigned_url_timeout use the Timestamp format
  // (<seconds>:<nanoseconds>). The default presigned PUT TTL is well within
  // these minimums.
  min_object_timeout: '300:0',
  min_presigned_url_timeout: '30:0',
  event_stream_mechanisms: [{ name: 'webhooks' }],
  // Image build time (see Dockerfile). Omitted when not built via Docker.
  ...(buildStamp ? { build: buildStamp } : {})
};

const opts = {
  schema: {
    tags: ['Service'],
    description: 'Get the service descriptor'
  }
};

const getService: FastifyPluginCallback = (fastify, _, next) => {
  fastify.get('/service', opts, async (_request, reply) => {
    reply.code(200).send(SERVICE);
  });
  next();
};

export default getService;
