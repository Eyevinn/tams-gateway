import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

vi.mock('../../../db/client', () => ({
  flowsClient: { get: vi.fn() },
  segmentsClient: { find: vi.fn(), bulk: vi.fn() },
  deletionRequestsClient: { insert: vi.fn() }
}));
vi.mock('../../utils/deleteS3Objects', () => ({
  __esModule: true,
  default: vi.fn(async () => ({ deleted: [], errors: [] }))
}));
vi.mock('../../utils/notifyWebhooks', () => ({
  __esModule: true,
  default: vi.fn(async () => undefined)
}));

import {
  flowsClient,
  segmentsClient,
  deletionRequestsClient
} from '../../../db/client';
import notifyWebhooks from '../../utils/notifyWebhooks';
import deleteSegments from './deleteSegments';

const flows = flowsClient as unknown as { get: Mock };
const segments = segmentsClient as unknown as { find: Mock; bulk: Mock };
const requests = deletionRequestsClient as unknown as { insert: Mock };
const notify = notifyWebhooks as unknown as Mock;

const buildApp = (): FastifyInstance => {
  const app = fastify().withTypeProvider<TypeBoxTypeProvider>();
  app.register(deleteSegments);
  return app;
};

// Distinguish the delete-loop query (flow_id) from the reclaim reference check
// (object_id). The reclaim check returns no references so the object is
// reclaimable; the delete loop returns the given docs once, then nothing.
const scriptFind = (loopDocs: Record<string, unknown>[]) => {
  let served = false;
  segments.find.mockImplementation(
    async (q: { selector: { object_id?: string } }) => {
      if ('object_id' in q.selector) return { docs: [] };
      if (served) return { docs: [] };
      served = true;
      return { docs: loopDocs };
    }
  );
};

const seg = (start: number, end: number, object_id = `bucket/${start}`) => ({
  _id: `flow-1:${start}:${object_id}`,
  _rev: '1-abc',
  object_id,
  ts_start: (BigInt(start) * 1_000_000_000n).toString().padStart(20, '0'),
  ts_end: (BigInt(end) * 1_000_000_000n).toString().padStart(20, '0')
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('deleteSegments', () => {
  it('deletes covered segments, records the request, and emits the event', async () => {
    flows.get.mockResolvedValue({ _id: 'flow-1', read_only: false });
    scriptFind([seg(0, 2), seg(2, 4)]);
    segments.bulk.mockResolvedValue([]);
    requests.insert.mockResolvedValue({ ok: true });

    const app = buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/flows/flow-1/segments?timerange=[0:0_4:0)'
    });

    expect(res.statusCode).toBe(204);
    // Bulk delete marked both docs _deleted.
    const bulked = segments.bulk.mock.calls[0][0].docs;
    expect(bulked).toHaveLength(2);
    expect(bulked.every((d: { _deleted: boolean }) => d._deleted)).toBe(true);
    // A done delete-request was recorded for the actual deleted span.
    expect(requests.insert.mock.calls[0][0].status).toBe('done');
    expect(requests.insert.mock.calls[0][0].timerange_to_delete).toBe(
      '[0:0_4:0)'
    );
    // The segments_deleted event fired with the deleted timerange.
    expect(notify).toHaveBeenCalledWith(
      'flows/segments_deleted',
      { flow_id: 'flow-1', timerange: '[0:0_4:0)' },
      { flowId: 'flow-1' }
    );
    await app.close();
  });

  it('builds a containment selector (ts_start >= start, ts_end <= end)', async () => {
    flows.get.mockResolvedValue({ _id: 'flow-1' });
    scriptFind([]);

    const app = buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/flows/flow-1/segments?timerange=[5:0_15:0)'
    });

    expect(res.statusCode).toBe(204);
    const selector = segments.find.mock.calls[0][0].selector;
    expect(selector.ts_start).toEqual({ $gte: '00000000005000000000' });
    expect(selector.ts_end).toEqual({ $lte: '00000000015000000000' });
    // Nothing matched: no request recorded, no event.
    expect(requests.insert).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 404 for an unknown flow', async () => {
    flows.get.mockRejectedValue({ statusCode: 404 });

    const app = buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/flows/missing/segments'
    });

    expect(res.statusCode).toBe(404);
    expect(segments.bulk).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 403 for a read-only flow', async () => {
    flows.get.mockResolvedValue({ _id: 'flow-1', read_only: true });

    const app = buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/flows/flow-1/segments'
    });

    expect(res.statusCode).toBe(403);
    expect(segments.find).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 400 for an unparseable timerange', async () => {
    flows.get.mockResolvedValue({ _id: 'flow-1' });

    const app = buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/flows/flow-1/segments?timerange=nonsense'
    });

    expect(res.statusCode).toBe(400);
    expect(segments.bulk).not.toHaveBeenCalled();
    await app.close();
  });
});
