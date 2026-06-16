import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

vi.mock('../../utils/createS3URL', () => ({
  __esModule: true,
  default: vi.fn(
    async (_method: string, key?: string) => `https://s3.example/${key}`
  )
}));

import postStorage from './postStorage';

const build = (): FastifyInstance => {
  const app = fastify().withTypeProvider<TypeBoxTypeProvider>();
  app.register(postStorage);
  return app;
};

describe('postStorage', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.S3_BUCKET;
    process.env.S3_BUCKET = 'tams-bucket';
  });

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.S3_BUCKET;
    } else {
      process.env.S3_BUCKET = saved;
    }
  });

  it('allocates one object in the configured bucket by default', async () => {
    const app = build();
    const res = await app.inject({
      method: 'POST',
      url: '/flows/flow-1/storage',
      payload: {}
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.media_objects).toHaveLength(1);
    expect(body.media_objects[0].object_id.startsWith('tams-bucket/')).toBe(
      true
    );
    expect(body.media_objects[0].put_url['content-type']).toBe('video/mp2t');
    await app.close();
  });

  it('honors limit and content_type', async () => {
    const app = build();
    const res = await app.inject({
      method: 'POST',
      url: '/flows/flow-1/storage',
      payload: { limit: 3, content_type: 'video/mp4' }
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.media_objects).toHaveLength(3);
    expect(body.media_objects[0].put_url['content-type']).toBe('video/mp4');
    await app.close();
  });

  it('rejects a limit above the server cap with 400 (DoS guard)', async () => {
    // An unbounded limit previously allocated until the V8 heap OOMed; the
    // schema now caps it so an over-limit request is rejected, not fatal.
    const app = build();
    const res = await app.inject({
      method: 'POST',
      url: '/flows/flow-1/storage',
      payload: { limit: 1_000_001 }
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
