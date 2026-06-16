import { describe, it, expect, beforeEach, vi } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

// Shared in-memory document stores standing in for the CouchDB `flows` and
// `sources` collections. They let a single test PUT a flow and then GET
// /sources to prove the Source/Flow linkage end to end: putFlow upserts a
// Source keyed by source_id into the same `sources` collection that
// listSources reads from. Declared via vi.hoisted so they are initialised
// before the hoisted vi.mock factory references them.
const { flowDocs, sourceDocs } = vi.hoisted(() => ({
  flowDocs: new Map<string, Record<string, unknown>>(),
  sourceDocs: new Map<string, Record<string, unknown>>()
}));

vi.mock('../../../db/client', () => {
  const makeClient = (store: Map<string, Record<string, unknown>>) => ({
    get: vi.fn(async (id: string) => {
      const doc = store.get(id);
      if (!doc) {
        throw { statusCode: 404 };
      }
      return doc;
    }),
    insert: vi.fn(async (doc: Record<string, unknown>) => {
      store.set(doc._id as string, doc);
      return { ok: true, id: doc._id, rev: '1-test' };
    }),
    list: vi.fn(async () => ({
      rows: [...store.values()].map((doc) => ({ doc }))
    }))
  });
  return {
    flowsClient: makeClient(flowDocs),
    sourcesClient: makeClient(sourceDocs)
  };
});

import putFlow from '../flows/putFlow';
import listSources from './listSources';

const buildApp = (): FastifyInstance => {
  const app = fastify().withTypeProvider<TypeBoxTypeProvider>();
  app.register(putFlow);
  app.register(listSources);
  return app;
};

const videoFlow = {
  id: '00000000-0000-1000-8000-000000000000',
  source_id: '2aa143ac-0ab7-4d75-bc32-5c00c13d186f',
  codec: 'video/h264',
  format: 'urn:x-nmos:format:video',
  essence_parameters: {}
};

beforeEach(() => {
  flowDocs.clear();
  sourceDocs.clear();
  vi.clearAllMocks();
});

describe('Source/Flow linkage via GET /sources', () => {
  it('reflects the Source referenced by a PUT flow in GET /sources', async () => {
    const app = buildApp();

    // Before any flow exists, GET /sources is empty.
    const before = await app.inject({ method: 'GET', url: '/sources' });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toEqual([]);

    // PUT a flow that references a source_id.
    const put = await app.inject({
      method: 'PUT',
      url: `/flows/${videoFlow.id}`,
      payload: videoFlow
    });
    expect(put.statusCode).toBe(201);

    // GET /sources now reflects the Source created from the flow's source_id,
    // carrying the flow's format and stripped of CouchDB bookkeeping fields.
    const after = await app.inject({ method: 'GET', url: '/sources' });
    expect(after.statusCode).toBe(200);
    const sources = after.json();
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      id: videoFlow.source_id,
      format: videoFlow.format
    });
    expect(sources[0]._id).toBeUndefined();
    expect(sources[0]._rev).toBeUndefined();

    await app.close();
  });

  it('does not duplicate the Source when two flows share a source_id', async () => {
    const app = buildApp();

    await app.inject({
      method: 'PUT',
      url: `/flows/${videoFlow.id}`,
      payload: videoFlow
    });
    await app.inject({
      method: 'PUT',
      url: '/flows/00000000-0000-1000-8000-000000000002',
      payload: { ...videoFlow, id: '00000000-0000-1000-8000-000000000002' }
    });

    const after = await app.inject({ method: 'GET', url: '/sources' });
    expect(after.json()).toHaveLength(1);

    await app.close();
  });
});
