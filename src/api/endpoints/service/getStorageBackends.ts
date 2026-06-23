import { FastifyPluginCallback } from 'fastify';
import { DEFAULT_AWS_REGION } from '../../../config';

// Fixed identifier for the gateway's single, implicit object-store backend (the
// pre-provisioned S3_BUCKET). The gateway exposes exactly one backend, so a
// stable constant id is sufficient and matches the spec's uuid format.
const BACKEND_ID = '00000000-0000-4000-8000-000000000001';

const opts = {
  schema: {
    tags: ['Service'],
    description: 'List the storage backends available on this service instance'
  }
};

// Describe the single object-store backend the gateway writes to (S3_BUCKET on
// the configured S3-compatible endpoint). store_type is the only enum value the
// spec defines (http_object_store); provider is informative, derived from the
// endpoint host when an S3_ENDPOINT_URL is set (e.g. MinIO on OSC) or "aws"
// against native S3.
const getStorageBackends: FastifyPluginCallback = (fastify, _, next) => {
  fastify.get('/service/storage-backends', opts, async (_request, reply) => {
    const endpoint = process.env.S3_ENDPOINT_URL;
    let provider = 'aws';
    if (endpoint) {
      try {
        provider = new URL(endpoint).hostname;
      } catch {
        provider = 'custom';
      }
    }
    const backend = {
      id: BACKEND_ID,
      label: process.env.S3_BUCKET,
      store_type: 'http_object_store',
      provider,
      region: process.env.AWS_REGION || DEFAULT_AWS_REGION,
      store_product: 's3',
      default_storage: true
    };
    reply.code(200).send([backend]);
  });
  next();
};

export default getStorageBackends;
