import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

vi.mock('../../db/client', () => ({
  client: { db: { list: vi.fn() } }
}));

import { client } from '../../db/client';
import readiness from './readiness';

const dbList = (client as unknown as { db: { list: Mock } }).db.list;

const build = (): FastifyInstance => {
  const app = fastify().withTypeProvider<TypeBoxTypeProvider>();
  app.register(readiness);
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('readiness', () => {
  it('returns 200 when the database is reachable', async () => {
    dbList.mockResolvedValue(['flows', 'sources', 'segments']);
    const app = build();
    const res = await app.inject({ method: 'GET', url: '/readiness' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready' });
    await app.close();
  });

  it('returns 503 when the database is unreachable', async () => {
    dbList.mockRejectedValue(new Error('connection refused'));
    const app = build();
    const res = await app.inject({ method: 'GET', url: '/readiness' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'unavailable' });
    await app.close();
  });
});
