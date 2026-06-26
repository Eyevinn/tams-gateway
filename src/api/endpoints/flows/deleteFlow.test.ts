import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

// DELETE /flows/{id} is now asynchronous: it validates the flow exists, persists
// a Flow Delete Request (status `created`) and returns 202 with a Location
// header. The actual per-batch delete + reclaim runs in the background worker
// (covered by deletionWorker.test.ts), not in the request handler.
vi.mock('../../../db/client', () => ({
  flowsClient: { get: vi.fn() },
  deletionRequestsClient: { insert: vi.fn() }
}));

import { flowsClient, deletionRequestsClient } from '../../../db/client';
import deleteFlow from './deleteFlow';

const flows = flowsClient as unknown as { get: Mock };
const requests = deletionRequestsClient as unknown as { insert: Mock };

const buildApp = (): FastifyInstance => {
  const app = fastify().withTypeProvider<TypeBoxTypeProvider>();
  app.register(deleteFlow);
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();
  requests.insert.mockResolvedValue({ ok: true, rev: '1-abc' });
});

describe('deleteFlow', () => {
  it('returns 202 and creates a created delete-request for an existing flow', async () => {
    flows.get.mockResolvedValue({ _id: 'flow-1', _rev: '1-abc' });

    const app = buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/flows/flow-1' });

    expect(res.statusCode).toBe(202);

    // A request doc was persisted for the whole flow.
    expect(requests.insert).toHaveBeenCalledTimes(1);
    const doc = requests.insert.mock.calls[0][0];
    expect(doc.status).toBe('created');
    expect(doc.flow_id).toBe('flow-1');
    expect(doc.delete_flow).toBe(true);
    expect(doc.timerange_to_delete).toBe('_');
    expect(doc.id).toBeDefined();

    // The Location header points at the created request.
    expect(res.headers.location).toBe(`/flow-delete-requests/${doc.id}`);

    // The 202 body is the spec deletion-request object (no _id/_rev, no
    // worker-only fields).
    const body = res.json();
    expect(body.id).toBe(doc.id);
    expect(body.status).toBe('created');
    expect(body.delete_flow).toBe(true);
    expect(body._id).toBeUndefined();
    expect(body._rev).toBeUndefined();
    expect(body.object_id_filter).toBeUndefined();
    await app.close();
  });

  it('captures the flow source_id on the request (worker-only, stripped from the body)', async () => {
    flows.get.mockResolvedValue({
      _id: 'flow-1',
      _rev: '1-abc',
      source_id: 'src-1'
    });

    const app = buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/flows/flow-1' });

    expect(res.statusCode).toBe(202);
    // Persisted so the worker can reclaim an orphaned Source after the flow is
    // gone, even on a resumed run.
    expect(requests.insert.mock.calls[0][0].source_id).toBe('src-1');
    // But source_id is a worker-only field, not part of the spec
    // deletion-request object, so it never appears in the client response.
    expect(res.json().source_id).toBeUndefined();
    await app.close();
  });

  it('returns 404 for an unknown flow and creates no request', async () => {
    flows.get.mockRejectedValue({ statusCode: 404 });

    const app = buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/flows/missing' });

    expect(res.statusCode).toBe(404);
    expect(requests.insert).not.toHaveBeenCalled();
    await app.close();
  });
});
