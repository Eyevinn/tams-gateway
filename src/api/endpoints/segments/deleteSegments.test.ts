import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

// DELETE /flows/{id}/segments is now asynchronous: it validates the flow
// (404/403), validates the timerange (400), persists a Flow Delete Request
// (status `created`) and returns 202. The per-batch delete + reclaim runs in the
// background worker (deletionWorker.test.ts / performDeletion.test.ts).
vi.mock('../../../db/client', () => ({
  flowsClient: { get: vi.fn() },
  deletionRequestsClient: { insert: vi.fn() }
}));

import { flowsClient, deletionRequestsClient } from '../../../db/client';
import deleteSegments from './deleteSegments';

const flows = flowsClient as unknown as { get: Mock };
const requests = deletionRequestsClient as unknown as { insert: Mock };

const buildApp = (): FastifyInstance => {
  const app = fastify().withTypeProvider<TypeBoxTypeProvider>();
  app.register(deleteSegments);
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();
  requests.insert.mockResolvedValue({ ok: true, rev: '1-abc' });
});

describe('deleteSegments', () => {
  it('returns 202 and creates a created delete-request scoped to the timerange', async () => {
    flows.get.mockResolvedValue({ _id: 'flow-1', read_only: false });

    const app = buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/flows/flow-1/segments?timerange=[0:0_4:0)'
    });

    expect(res.statusCode).toBe(202);
    expect(requests.insert).toHaveBeenCalledTimes(1);
    const doc = requests.insert.mock.calls[0][0];
    expect(doc.status).toBe('created');
    expect(doc.flow_id).toBe('flow-1');
    expect(doc.delete_flow).toBe(false);
    expect(doc.timerange_to_delete).toBe('[0:0_4:0)');
    expect(res.headers.location).toBe(`/flow-delete-requests/${doc.id}`);

    const body = res.json();
    expect(body.status).toBe('created');
    expect(body._id).toBeUndefined();
    // The object_id filter is an internal worker field, never returned.
    expect(body.object_id_filter).toBeUndefined();
    await app.close();
  });

  it('persists the object_id filter (worker-only) when given', async () => {
    flows.get.mockResolvedValue({ _id: 'flow-1', read_only: false });

    const app = buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/flows/flow-1/segments?object_id=bucket/obj-1'
    });

    expect(res.statusCode).toBe(202);
    const doc = requests.insert.mock.calls[0][0];
    expect(doc.object_id_filter).toBe('bucket/obj-1');
    // But it is stripped from the client-facing body.
    expect(res.json().object_id_filter).toBeUndefined();
    await app.close();
  });

  it('returns 404 for an unknown flow and creates no request', async () => {
    flows.get.mockRejectedValue({ statusCode: 404 });

    const app = buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/flows/missing/segments'
    });

    expect(res.statusCode).toBe(404);
    expect(requests.insert).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 403 for a read-only flow and creates no request', async () => {
    flows.get.mockResolvedValue({ _id: 'flow-1', read_only: true });

    const app = buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/flows/flow-1/segments'
    });

    expect(res.statusCode).toBe(403);
    expect(requests.insert).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 400 for an unparseable timerange and creates no request', async () => {
    flows.get.mockResolvedValue({ _id: 'flow-1', read_only: false });

    const app = buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/flows/flow-1/segments?timerange=nonsense'
    });

    expect(res.statusCode).toBe(400);
    expect(requests.insert).not.toHaveBeenCalled();
    await app.close();
  });
});
