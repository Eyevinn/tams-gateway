import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

vi.mock('../../../db/client', () => ({
  flowsClient: { get: vi.fn(), insert: vi.fn() },
  sourcesClient: { get: vi.fn(), insert: vi.fn() },
  // notifyWebhooks queries this; no subscribers in these tests.
  webhooksClient: { find: vi.fn().mockResolvedValue({ docs: [] }) }
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

// A grouping Multi-Flow: no codec, no container, no essence_parameters of its
// own (flow-multi.json), collecting per-essence Flows via flow_collection.
const multiFlow = {
  id: '00000000-0000-1000-8000-0000000000a0',
  source_id: '00000000-0000-1000-8000-0000000000a1',
  format: 'urn:x-nmos:format:multi',
  flow_collection: [
    // Member with only id + role (collection-item.json): no container_mapping.
    { id: '00000000-0000-1000-8000-0000000000b0', role: 'video' },
    // Member with a container_mapping carrying integer track indices.
    {
      id: '00000000-0000-1000-8000-0000000000b1',
      role: 'L',
      container_mapping: {
        track_index: 1,
        format_track_index: 0,
        mp2ts_container: { pid: 257 }
      }
    }
  ]
};

const mockCreate = () => {
  flows.get.mockRejectedValue({ statusCode: 404 });
  flows.insert.mockResolvedValue({ ok: true });
  sources.get.mockRejectedValue({ statusCode: 404 });
  sources.insert.mockResolvedValue({ ok: true });
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

  it('strips unknown extra properties so they are never stored or echoed', async () => {
    // The conformance fuzzer PUT a flow with an arbitrary extra key; the open
    // schema let it through, persisted it, and echoed it back, violating
    // flow.json. additionalProperties: false (with Fastify's default
    // removeAdditional) now strips unknown keys before the handler.
    flows.get.mockRejectedValue({ statusCode: 404 });
    flows.insert.mockResolvedValue({ ok: true });
    sources.get.mockRejectedValue({ statusCode: 404 });
    sources.insert.mockResolvedValue({ ok: true });

    const app = buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/flows/${audioFlow.id}`,
      payload: { ...audioFlow, unexpectedKey: { nested: 'garbage' } }
    });

    expect(res.statusCode).toBe(201);
    const stored = flows.insert.mock.calls[0][0];
    expect(stored).not.toHaveProperty('unexpectedKey');
    expect(res.json()).not.toHaveProperty('unexpectedKey');
    await app.close();
  });

  it('accepts collected_by as an array but ignores it (read-only) when persisting', async () => {
    flows.get.mockRejectedValue({ statusCode: 404 });
    flows.insert.mockResolvedValue({ ok: true });
    sources.get.mockRejectedValue({ statusCode: 404 });
    sources.insert.mockResolvedValue({ ok: true });

    const app = buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/flows/${audioFlow.id}`,
      payload: {
        ...audioFlow,
        collected_by: ['00000000-0000-1000-8000-0000000000aa']
      }
    });

    // The array type is now valid (no 400, no coercion to string), and the
    // server-managed field is stripped before persist and not echoed back.
    expect(res.statusCode).toBe(201);
    const stored = flows.insert.mock.calls[0][0];
    expect(stored).not.toHaveProperty('collected_by');
    expect(res.json()).not.toHaveProperty('collected_by');
    await app.close();
  });

  it('accepts a Multi-Flow with no codec/container and stores it (201)', async () => {
    // flow-multi.json requires only id, source_id and format. Previously the
    // request schema marked codec and essence_parameters required, so a
    // spec-valid Multi-Flow was rejected with 400.
    mockCreate();

    const app = buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/flows/${multiFlow.id}`,
      payload: multiFlow
    });

    expect(res.statusCode).toBe(201);
    expect(flows.insert).toHaveBeenCalledTimes(1);
    const stored = flows.insert.mock.calls[0][0];
    expect(stored).not.toHaveProperty('codec');
    await app.close();
  });

  it('accepts flow_collection items with only id + role', async () => {
    // collection-item.json requires only id + role; container_mapping was
    // wrongly required, rejecting a bare member with 400.
    mockCreate();

    const app = buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/flows/${multiFlow.id}`,
      payload: multiFlow
    });

    expect(res.statusCode).toBe(201);
    const stored = flows.insert.mock.calls[0][0];
    expect(stored.flow_collection[0]).toEqual({
      id: '00000000-0000-1000-8000-0000000000b0',
      role: 'video'
    });
    await app.close();
  });

  it('round-trips container_mapping track indices as integers, not strings', async () => {
    // container-mapping.json types track_index/format_track_index as integer.
    // The String schema coerced numeric input to a string ("0"); they must
    // persist and echo back as numbers.
    mockCreate();

    const app = buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/flows/${multiFlow.id}`,
      payload: multiFlow
    });

    expect(res.statusCode).toBe(201);
    const mapping = res.json().flow_collection[1].container_mapping;
    expect(mapping.track_index).toBe(1);
    expect(mapping.format_track_index).toBe(0);
    expect(typeof mapping.track_index).toBe('number');
    expect(typeof mapping.format_track_index).toBe('number');

    const storedMapping =
      flows.insert.mock.calls[0][0].flow_collection[1].container_mapping;
    expect(typeof storedMapping.track_index).toBe('number');
    await app.close();
  });

  it('derives the Source source_collection from flow_collection members', async () => {
    // source.json + app note 0001: source_collection is server-managed and
    // inferred from the Flow collection. Each member Flow is resolved to its
    // own source_id, carrying the role from the flow_collection item.
    const memberFlows: Record<string, { source_id: string }> = {
      '00000000-0000-1000-8000-0000000000b0': {
        source_id: '00000000-0000-1000-8000-0000000000c0'
      },
      '00000000-0000-1000-8000-0000000000b1': {
        source_id: '00000000-0000-1000-8000-0000000000c1'
      }
    };
    // The mux flow does not exist yet (404); member flows resolve to their docs.
    flows.get.mockImplementation((flowId: string) => {
      if (memberFlows[flowId]) {
        return Promise.resolve({ _id: flowId, ...memberFlows[flowId] });
      }
      return Promise.reject({ statusCode: 404 });
    });
    flows.insert.mockResolvedValue({ ok: true });
    sources.get.mockRejectedValue({ statusCode: 404 });
    sources.insert.mockResolvedValue({ ok: true });

    const app = buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/flows/${multiFlow.id}`,
      payload: multiFlow
    });

    expect(res.statusCode).toBe(201);
    const storedSource = sources.insert.mock.calls[0][0];
    expect(storedSource.source_collection).toEqual([
      { id: '00000000-0000-1000-8000-0000000000c0', role: 'video' },
      { id: '00000000-0000-1000-8000-0000000000c1', role: 'L' }
    ]);
    await app.close();
  });

  it('skips unresolved flow_collection members when deriving source_collection', async () => {
    // Best-effort derivation: a member Flow not yet registered (404) is omitted
    // rather than failing the whole PUT.
    flows.get.mockImplementation((flowId: string) => {
      if (flowId === '00000000-0000-1000-8000-0000000000b0') {
        return Promise.resolve({
          _id: flowId,
          source_id: '00000000-0000-1000-8000-0000000000c0'
        });
      }
      return Promise.reject({ statusCode: 404 });
    });
    flows.insert.mockResolvedValue({ ok: true });
    sources.get.mockRejectedValue({ statusCode: 404 });
    sources.insert.mockResolvedValue({ ok: true });

    const app = buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/flows/${multiFlow.id}`,
      payload: multiFlow
    });

    expect(res.statusCode).toBe(201);
    const storedSource = sources.insert.mock.calls[0][0];
    expect(storedSource.source_collection).toEqual([
      { id: '00000000-0000-1000-8000-0000000000c0', role: 'video' }
    ]);
    await app.close();
  });
});
