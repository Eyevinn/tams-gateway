import { FastifyPluginCallback } from 'fastify';

// Minimal TAMS service descriptor (service.json). Its purpose here is discovery:
// listing "webhooks" in event_stream_mechanisms is how a client learns this
// gateway supports the webhook endpoints (per the webhooks endpoint docs).
// Required fields per service.json: type, api_version, min_object_timeout.
const SERVICE = {
  name: 'TAMS Gateway',
  description:
    'Time-addressable Media Store (TAMS) gateway: indexes segmented media flows and serves presigned URLs.',
  type: 'urn:x-tams:service:tams-gateway',
  // The TAMS API version this gateway targets (vendored spec tag).
  api_version: '8.1',
  // min_object_timeout / min_presigned_url_timeout use the Timestamp format
  // (<seconds>:<nanoseconds>). The default presigned PUT TTL is well within
  // these minimums.
  min_object_timeout: '300:0',
  min_presigned_url_timeout: '30:0',
  event_stream_mechanisms: [{ name: 'webhooks' }]
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
