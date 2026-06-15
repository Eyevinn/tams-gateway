import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import fastify, { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

vi.mock('../../../db/client', () => ({
  segmentsClient: {
    get: vi.fn(),
    insert: vi.fn(),
    find: vi.fn()
  }
}));
vi.mock('../../utils/createS3URL', () => ({
  __esModule: true,
  default: vi.fn(async () => 'https://s3.example/signed')
}));

import { segmentsClient } from '../../../db/client';
import postSegments from './postSegments';
import listSegments from './listSegments';

const mockClient = segmentsClient as unknown as {
  get: Mock;
  insert: Mock;
  find: Mock;
};

const buildApp = (plugin: FastifyPluginCallback): FastifyInstance => {
  const app = fastify().withTypeProvider<TypeBoxTypeProvider>();
  app.register(plugin);
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('postSegments', () => {
  it('upserts a new segment with derived flow_id and keys', async () => {
    mockClient.get.mockRejectedValue({ statusCode: 404 });
    mockClient.insert.mockResolvedValue({ ok: true });

    const app = buildApp(postSegments);
    const res = await app.inject({
      method: 'POST',
      url: '/flows/flow-1/segments',
      payload: { object_id: 'bucket/obj-1', timerange: '[0:0_10:0)' }
    });

    expect(res.statusCode).toBe(201);
    const doc = mockClient.insert.mock.calls[0][0];
    expect(doc.flow_id).toBe('flow-1');
    expect(doc.ts_start).toBe('00000000000000000000');
    expect(doc.ts_end).toBe('00000000010000000000');
    expect(doc._id).toBe('flow-1:00000000000000000000:bucket/obj-1');
    expect(doc._rev).toBeUndefined();
    await app.close();
  });

  it('reuses the revision when the segment already exists', async () => {
    mockClient.get.mockResolvedValue({ _rev: '2-abc' });
    mockClient.insert.mockResolvedValue({ ok: true });

    const app = buildApp(postSegments);
    const res = await app.inject({
      method: 'POST',
      url: '/flows/flow-1/segments',
      payload: { object_id: 'bucket/obj-1', timerange: '[0:0_10:0)' }
    });

    expect(res.statusCode).toBe(201);
    expect(mockClient.insert.mock.calls[0][0]._rev).toBe('2-abc');
    await app.close();
  });

  it('rejects a malformed timerange', async () => {
    const app = buildApp(postSegments);
    const res = await app.inject({
      method: 'POST',
      url: '/flows/flow-1/segments',
      payload: { object_id: 'bucket/obj-1', timerange: 'nonsense' }
    });

    expect(res.statusCode).toBe(400);
    expect(mockClient.insert).not.toHaveBeenCalled();
    await app.close();
  });

  it('registers an array of segments and returns 201 with no body', async () => {
    mockClient.get.mockRejectedValue({ statusCode: 404 });
    mockClient.insert.mockResolvedValue({ ok: true });

    const app = buildApp(postSegments);
    const res = await app.inject({
      method: 'POST',
      url: '/flows/flow-1/segments',
      payload: [
        { object_id: 'bucket/obj-1', timerange: '[0:0_10:0)' },
        { object_id: 'bucket/obj-2', timerange: '[10:0_20:0)' }
      ]
    });

    expect(res.statusCode).toBe(201);
    expect(res.body).toBe('');
    expect(mockClient.insert).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it('returns 200 with the failed segments on partial failure', async () => {
    mockClient.get.mockRejectedValue({ statusCode: 404 });
    // First insert fails, second succeeds.
    mockClient.insert
      .mockRejectedValueOnce(new Error('conflict'))
      .mockResolvedValueOnce({ ok: true });

    const app = buildApp(postSegments);
    const res = await app.inject({
      method: 'POST',
      url: '/flows/flow-1/segments',
      payload: [
        { object_id: 'bucket/obj-1', timerange: '[0:0_10:0)' },
        { object_id: 'bucket/obj-2', timerange: '[10:0_20:0)' }
      ]
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.failed_segments).toHaveLength(1);
    expect(body.failed_segments[0].object_id).toBe('bucket/obj-1');
    expect(body.failed_segments[0].error.summary).toBe('conflict');
    await app.close();
  });
});

describe('listSegments', () => {
  it('queries by flow_id and overlap bounds and presigns get_urls', async () => {
    mockClient.find.mockResolvedValue({
      docs: [{ object_id: 'bucket/obj-1', timerange: '[0:0_10:0)' }]
    });

    const app = buildApp(listSegments);
    const res = await app.inject({
      method: 'GET',
      url: '/flows/flow-1/segments?timerange=[5:0_15:0)'
    });

    expect(res.statusCode).toBe(200);
    const selector = mockClient.find.mock.calls[0][0].selector;
    expect(selector.flow_id).toBe('flow-1');
    expect(selector.ts_start).toEqual({ $lt: '00000000015000000000' });
    expect(selector.ts_end).toEqual({ $gt: '00000000005000000000' });

    const body = res.json();
    expect(body[0].get_urls[0].url).toBe('https://s3.example/signed');
    await app.close();
  });

  it('rejects an unparseable timerange with 400', async () => {
    const app = buildApp(listSegments);
    const res = await app.inject({
      method: 'GET',
      url: '/flows/flow-1/segments?timerange=%C2%84'
    });

    expect(res.statusCode).toBe(400);
    expect(mockClient.find).not.toHaveBeenCalled();
    await app.close();
  });

  it('omits the timerange selector when no timerange is given', async () => {
    mockClient.find.mockResolvedValue({ docs: [] });

    const app = buildApp(listSegments);
    const res = await app.inject({
      method: 'GET',
      url: '/flows/flow-1/segments'
    });

    expect(res.statusCode).toBe(200);
    expect(mockClient.find.mock.calls[0][0].selector).toEqual({
      flow_id: 'flow-1'
    });
    await app.close();
  });
});
