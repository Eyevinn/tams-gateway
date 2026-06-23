import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

vi.mock('../../../db/client', () => ({
  sourcesClient: { get: vi.fn() }
}));

import { sourcesClient } from '../../../db/client';
import getSource from './getSource';

const sources = sourcesClient as unknown as { get: Mock };

const buildApp = (): FastifyInstance => {
  const app = fastify().withTypeProvider<TypeBoxTypeProvider>();
  app.register(getSource);
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getSource', () => {
  it('returns the source without CouchDB bookkeeping fields', async () => {
    sources.get.mockResolvedValue({
      _id: 's1',
      _rev: '1-abc',
      id: 's1',
      format: 'urn:x-nmos:format:video'
    });

    const res = await buildApp().inject({ method: 'GET', url: '/sources/s1' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe('s1');
    expect(body.format).toBe('urn:x-nmos:format:video');
    expect(body._id).toBeUndefined();
    expect(body._rev).toBeUndefined();
  });

  it('returns 404 for an unknown source', async () => {
    sources.get.mockRejectedValue({ statusCode: 404 });

    const res = await buildApp().inject({
      method: 'GET',
      url: '/sources/missing'
    });

    expect(res.statusCode).toBe(404);
  });
});
