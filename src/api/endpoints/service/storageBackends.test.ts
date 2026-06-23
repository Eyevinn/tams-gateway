import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import getStorageBackends from './getStorageBackends';

const buildApp = (): FastifyInstance => {
  const app = fastify().withTypeProvider<TypeBoxTypeProvider>();
  app.register(getStorageBackends);
  return app;
};

const savedEnv = { ...process.env };

beforeEach(() => {
  process.env.S3_BUCKET = 'media-bucket';
  process.env.AWS_REGION = 'eu-north-1';
  delete process.env.S3_ENDPOINT_URL;
});

afterEach(() => {
  process.env = { ...savedEnv };
});

describe('getStorageBackends', () => {
  it('describes the single S3 backend with the spec-required fields', async () => {
    const res = await buildApp().inject({
      method: 'GET',
      url: '/service/storage-backends'
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    const backend = body[0];
    // Required by storage-backends-list.json.
    expect(backend.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(backend.store_type).toBe('http_object_store');
    expect(backend.provider).toBe('aws');
    expect(backend.store_product).toBe('s3');
    expect(backend.label).toBe('media-bucket');
    expect(backend.default_storage).toBe(true);
  });

  it('derives the provider from a custom S3 endpoint host (e.g. MinIO)', async () => {
    process.env.S3_ENDPOINT_URL = 'https://minio.example.osaas.io';
    const res = await buildApp().inject({
      method: 'GET',
      url: '/service/storage-backends'
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()[0].provider).toBe('minio.example.osaas.io');
  });
});
