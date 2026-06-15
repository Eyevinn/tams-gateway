import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

vi.mock('../../../db/client', () => ({
  flowsClient: { get: vi.fn(), insert: vi.fn() },
  sourcesClient: { get: vi.fn(), insert: vi.fn() }
}));

import { flowsClient, sourcesClient } from '../../../db/client';
import putFlow from './putFlow';

const flows = flowsClient as unknown as { get: Mock; insert: Mock };
const sources = sourcesClient as unknown as { get: Mock; insert: Mock };

const buildApp = (): FastifyInstance => {
  const app = fastify().withTypeProvider<TypeBoxTypeProvider>();
  app.register(putFlow);
  return app;
};

const audioFlow = {
  id: '00000000-0000-1000-8000-000000000000',
  source_id: '00000000-0000-1000-8000-000000000001',
  codec: 'audio/aac',
  format: 'urn:x-nmos:format:audio',
  essence_parameters: {}
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('putFlow', () => {
  it('rejects an empty source_id with 400 before touching the database', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/flows/${audioFlow.id}`,
      payload: { ...audioFlow, source_id: '' }
    });

    expect(res.statusCode).toBe(400);
    expect(flows.insert).not.toHaveBeenCalled();
    expect(sources.insert).not.toHaveBeenCalled();
    await app.close();
  });

  it('accepts an audio flow without frame dimensions and returns 201 on create', async () => {
    flows.get.mockRejectedValue({ statusCode: 404 });
    flows.insert.mockResolvedValue({ ok: true });
    sources.get.mockRejectedValue({ statusCode: 404 });
    sources.insert.mockResolvedValue({ ok: true });

    const app = buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/flows/${audioFlow.id}`,
      payload: audioFlow
    });

    expect(res.statusCode).toBe(201);
    expect(flows.insert).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('returns 204 with no body when updating an existing flow', async () => {
    flows.get.mockResolvedValue({ _id: audioFlow.id, _rev: '1-abc' });
    flows.insert.mockResolvedValue({ ok: true });
    sources.get.mockResolvedValue({ _id: audioFlow.source_id });
    sources.insert.mockResolvedValue({ ok: true });

    const app = buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/flows/${audioFlow.id}`,
      payload: audioFlow
    });

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    await app.close();
  });
});
