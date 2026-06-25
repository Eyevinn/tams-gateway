import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import fastify, { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

vi.mock('../../../db/client', () => ({
  segmentsClient: {
    get: vi.fn(),
    insert: vi.fn(),
    find: vi.fn(),
    // _all_docs keys lookup for existing revisions, then the bulk write.
    list: vi.fn(),
    bulk: vi.fn()
  },
  // notifyWebhooks queries this; no subscribers in these tests.
  webhooksClient: { find: vi.fn().mockResolvedValue({ docs: [] }) }
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
  list: Mock;
  bulk: Mock;
};

// An _all_docs (list with keys) response. By default every requested id is
// absent (a not_found error row with no value), so the handler inserts without
// a _rev. Pass `existing` to supply a current rev for specific ids, optionally
// tombstoned (deleted: true), exactly as CouchDB returns for a deleted id.
const allDocsResponse = (
  ids: string[],
  existing: Record<string, { rev: string; deleted?: boolean }> = {}
) => ({
  total_rows: 0,
  offset: 0,
  rows: ids.map((id) =>
    existing[id]
      ? { id, key: id, value: existing[id] }
      : { key: id, error: 'not_found' }
  )
});

// A _bulk_docs all-success response: one ok row (id + rev) per doc, in order.
const bulkOk = (docs: Array<{ _id: string }>) =>
  docs.map((doc, i) => ({ id: doc._id, rev: `1-rev${i}` }));

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
    const id = 'flow-1:00000000000000000000:bucket/obj-1';
    mockClient.list.mockResolvedValue(allDocsResponse([id]));
    mockClient.bulk.mockResolvedValue([{ id, rev: '1-new' }]);

    const app = buildApp(postSegments);
    const res = await app.inject({
      method: 'POST',
      url: '/flows/flow-1/segments',
      payload: { object_id: 'bucket/obj-1', timerange: '[0:0_10:0)' }
    });

    expect(res.statusCode).toBe(201);
    // One bulk write, not a per-segment insert loop.
    expect(mockClient.bulk).toHaveBeenCalledTimes(1);
    expect(mockClient.insert).not.toHaveBeenCalled();
    const docs = mockClient.bulk.mock.calls[0][0].docs;
    expect(docs).toHaveLength(1);
    const doc = docs[0];
    expect(doc.flow_id).toBe('flow-1');
    expect(doc.ts_start).toBe('00000000000000000000');
    expect(doc.ts_end).toBe('00000000010000000000');
    expect(doc._id).toBe(id);
    expect(doc._rev).toBeUndefined();
    // get_urls is presigned on read, never stored.
    expect(doc.get_urls).toBeUndefined();
    await app.close();
  });

  it('reuses the revision when the segment already exists (re-post upserts)', async () => {
    const id = 'flow-1:00000000000000000000:bucket/obj-1';
    mockClient.list.mockResolvedValue(
      allDocsResponse([id], { [id]: { rev: '2-abc' } })
    );
    mockClient.bulk.mockResolvedValue([{ id, rev: '3-def' }]);

    const app = buildApp(postSegments);
    const res = await app.inject({
      method: 'POST',
      url: '/flows/flow-1/segments',
      payload: { object_id: 'bucket/obj-1', timerange: '[0:0_10:0)' }
    });

    expect(res.statusCode).toBe(201);
    // The current rev from _all_docs is carried into the bulk doc so the
    // re-post upserts rather than conflicting.
    expect(mockClient.bulk.mock.calls[0][0].docs[0]._rev).toBe('2-abc');
    await app.close();
  });

  it('recreates a previously deleted segment using the tombstone rev (no 409)', async () => {
    const id = 'flow-1:00000000000000000000:bucket/obj-1';
    // _all_docs returns the tombstone row for a deleted id: value carries the
    // rev and deleted: true. A plain GET would have 404'd, dropping the rev and
    // forcing a conflict on insert.
    mockClient.list.mockResolvedValue(
      allDocsResponse([id], { [id]: { rev: '5-deleted', deleted: true } })
    );
    mockClient.bulk.mockResolvedValue([{ id, rev: '6-recreated' }]);

    const app = buildApp(postSegments);
    const res = await app.inject({
      method: 'POST',
      url: '/flows/flow-1/segments',
      payload: { object_id: 'bucket/obj-1', timerange: '[0:0_10:0)' }
    });

    expect(res.statusCode).toBe(201);
    // The tombstone rev is carried so CouchDB resurrects the doc instead of 409.
    expect(mockClient.bulk.mock.calls[0][0].docs[0]._rev).toBe('5-deleted');
    await app.close();
  });

  it('rejects a malformed timerange', async () => {
    const app = buildApp(postSegments);
    const res = await app.inject({
      method: 'POST',
      url: '/flows/flow-1/segments',
      payload: { object_id: 'bucket/obj-1', timerange: 'nonsense' }
    });

    // Schema validation rejects the body before the handler runs.
    expect(res.statusCode).toBe(400);
    expect(mockClient.bulk).not.toHaveBeenCalled();
    await app.close();
  });

  it('registers an array of segments in one bulk write and returns 201', async () => {
    const ids = [
      'flow-1:00000000000000000000:bucket/obj-1',
      'flow-1:00000000010000000000:bucket/obj-2'
    ];
    mockClient.list.mockResolvedValue(allDocsResponse(ids));
    mockClient.bulk.mockImplementation(async ({ docs }) => bulkOk(docs));

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
    // Two segments, still exactly one round-trip each for read and write.
    expect(mockClient.list).toHaveBeenCalledTimes(1);
    expect(mockClient.bulk).toHaveBeenCalledTimes(1);
    expect(mockClient.list.mock.calls[0][0].keys).toEqual(ids);
    expect(mockClient.bulk.mock.calls[0][0].docs).toHaveLength(2);
    await app.close();
  });

  it('returns 200 with the failed segments on partial failure', async () => {
    const ids = [
      'flow-1:00000000000000000000:bucket/obj-1',
      'flow-1:00000000010000000000:bucket/obj-2'
    ];
    mockClient.list.mockResolvedValue(allDocsResponse(ids));
    // First doc conflicts, second succeeds. Per-doc bulk errors map to
    // failed_segments while the batch as a whole still resolves.
    mockClient.bulk.mockResolvedValue([
      { id: ids[0], error: 'conflict', reason: 'Document update conflict.' },
      { id: ids[1], rev: '1-ok' }
    ]);

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
    expect(body.failed_segments[0].error.summary).toBe(
      'Document update conflict.'
    );
    await app.close();
  });

  it('fails only the bad timerange and bulk-writes the rest', async () => {
    const goodId = 'flow-1:00000000000000000000:bucket/obj-1';
    mockClient.list.mockResolvedValue(allDocsResponse([goodId]));
    mockClient.bulk.mockResolvedValue([{ id: goodId, rev: '1-ok' }]);

    const app = buildApp(postSegments);
    const res = await app.inject({
      method: 'POST',
      url: '/flows/flow-1/segments',
      payload: [
        { object_id: 'bucket/obj-1', timerange: '[0:0_10:0)' },
        // Passes the body schema (both bounds present) but the nanosecond key
        // overflows the 20-digit width, so segmentKeys throws and fails only
        // this segment, not the whole request.
        {
          object_id: 'bucket/obj-2',
          timerange: '[999999999999:0_999999999999:1)'
        }
      ]
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.failed_segments).toHaveLength(1);
    expect(body.failed_segments[0].object_id).toBe('bucket/obj-2');
    // The good segment is still written, in one bulk call.
    expect(mockClient.bulk.mock.calls[0][0].docs).toHaveLength(1);
    expect(mockClient.bulk.mock.calls[0][0].docs[0]._id).toBe(goodId);
    await app.close();
  });

  it('fails the whole batch with 200 when the bulk write throws after retries', async () => {
    const id = 'flow-1:00000000000000000000:bucket/obj-1';
    mockClient.list.mockResolvedValue(allDocsResponse([id]));
    mockClient.bulk.mockRejectedValue(new Error('service unavailable'));

    const app = buildApp(postSegments);
    const res = await app.inject({
      method: 'POST',
      url: '/flows/flow-1/segments',
      payload: { object_id: 'bucket/obj-1', timerange: '[0:0_10:0)' }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.failed_segments).toHaveLength(1);
    expect(body.failed_segments[0].object_id).toBe('bucket/obj-1');
    expect(body.failed_segments[0].error.summary).toBe('service unavailable');
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

  it('uses $lte on ts_start for an inclusive-end query', async () => {
    mockClient.find.mockResolvedValue({ docs: [] });

    const app = buildApp(listSegments);
    const res = await app.inject({
      method: 'GET',
      url: '/flows/flow-1/segments?timerange=[5:0_15:0]'
    });

    expect(res.statusCode).toBe(200);
    const selector = mockClient.find.mock.calls[0][0].selector;
    // Inclusive end => a segment beginning exactly at 15:0 must match.
    expect(selector.ts_start).toEqual({ $lte: '00000000015000000000' });
    expect(selector.ts_end).toEqual({ $gt: '00000000005000000000' });
    await app.close();
  });

  it('treats an instant query [t] as ts_start <= t and ts_end > t', async () => {
    mockClient.find.mockResolvedValue({ docs: [] });

    const app = buildApp(listSegments);
    const res = await app.inject({
      method: 'GET',
      url: '/flows/flow-1/segments?timerange=[10:0]'
    });

    expect(res.statusCode).toBe(200);
    const selector = mockClient.find.mock.calls[0][0].selector;
    // A segment starting exactly at 10:0 (ts_start == 10:0) must match.
    expect(selector.ts_start).toEqual({ $lte: '00000000010000000000' });
    expect(selector.ts_end).toEqual({ $gt: '00000000010000000000' });
    await app.close();
  });

  it('keeps $lt for an exclusive-end query (no regression)', async () => {
    mockClient.find.mockResolvedValue({ docs: [] });

    const app = buildApp(listSegments);
    const res = await app.inject({
      method: 'GET',
      url: '/flows/flow-1/segments?timerange=(5:0_15:0)'
    });

    expect(res.statusCode).toBe(200);
    const selector = mockClient.find.mock.calls[0][0].selector;
    expect(selector.ts_start).toEqual({ $lt: '00000000015000000000' });
    expect(selector.ts_end).toEqual({ $gt: '00000000005000000000' });
    await app.close();
  });

  it('omits the open side for half-open queries', async () => {
    mockClient.find.mockResolvedValue({ docs: [] });

    const app = buildApp(listSegments);
    const resStart = await app.inject({
      method: 'GET',
      url: '/flows/flow-1/segments?timerange=[10:0_'
    });
    expect(resStart.statusCode).toBe(200);
    const openEnd = mockClient.find.mock.calls[0][0].selector;
    expect(openEnd.ts_start).toBeUndefined();
    expect(openEnd.ts_end).toEqual({ $gt: '00000000010000000000' });

    vi.clearAllMocks();
    mockClient.find.mockResolvedValue({ docs: [] });
    const resEnd = await app.inject({
      method: 'GET',
      url: '/flows/flow-1/segments?timerange=_15:0)'
    });
    expect(resEnd.statusCode).toBe(200);
    const openStart = mockClient.find.mock.calls[0][0].selector;
    expect(openStart.ts_start).toEqual({ $lt: '00000000015000000000' });
    expect(openStart.ts_end).toBeUndefined();
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

  it('sorts ascending by default', async () => {
    mockClient.find.mockResolvedValue({ docs: [] });

    const app = buildApp(listSegments);
    const res = await app.inject({
      method: 'GET',
      url: '/flows/flow-1/segments'
    });

    expect(res.statusCode).toBe(200);
    expect(mockClient.find.mock.calls[0][0].sort).toEqual([
      { flow_id: 'asc' },
      { ts_start: 'asc' }
    ]);
    await app.close();
  });

  it('sorts descending for reverse_order=true (newest first, enables span discovery)', async () => {
    mockClient.find.mockResolvedValue({ docs: [] });

    const app = buildApp(listSegments);
    const res = await app.inject({
      method: 'GET',
      url: '/flows/flow-1/segments?reverse_order=true&limit=1'
    });

    expect(res.statusCode).toBe(200);
    expect(mockClient.find.mock.calls[0][0].sort).toEqual([
      { flow_id: 'desc' },
      { ts_start: 'desc' }
    ]);
    // Paging fetches one extra row (limit + 1) to detect a following page.
    expect(mockClient.find.mock.calls[0][0].limit).toBe(2);
    await app.close();
  });
});

describe('listSegments paging', () => {
  // ts_start / ts_end are 20-digit nanosecond keys. A segment starting at `sec`
  // seconds and 2 seconds long.
  const docAt = (sec: number) => {
    const startNs = BigInt(sec) * 1_000_000_000n;
    const endNs = startNs + 2_000_000_000n;
    return {
      object_id: `bucket/${sec}`,
      timerange: `[${sec}:0_${sec + 2}:0)`,
      ts_start: startNs.toString().padStart(20, '0'),
      ts_end: endNs.toString().padStart(20, '0')
    };
  };
  const tsKey = (sec: number) =>
    (BigInt(sec) * 1_000_000_000n).toString().padStart(20, '0');

  it('always returns the paging headers', async () => {
    mockClient.find.mockResolvedValue({ docs: [docAt(0)] });

    const app = buildApp(listSegments);
    const res = await app.inject({
      method: 'GET',
      url: '/flows/flow-1/segments'
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-paging-limit']).toBe('1000');
    expect(res.headers['x-paging-count']).toBe('1');
    expect(res.headers['x-paging-reverse-order']).toBe('false');
    expect(res.headers['x-paging-timerange']).toBe('[0:0_2:0)');
    // Single page: no next cursor.
    expect(res.headers['x-paging-nextkey']).toBeUndefined();
    expect(res.headers['link']).toBeUndefined();
    await app.close();
  });

  it('emits NextKey and a Link header when a further page exists', async () => {
    // limit=2 fetches 3; the third row signals more and is the next cursor.
    mockClient.find.mockResolvedValue({
      docs: [docAt(0), docAt(2), docAt(4)]
    });

    const app = buildApp(listSegments);
    const res = await app.inject({
      method: 'GET',
      url: '/flows/flow-1/segments?limit=2'
    });

    expect(res.statusCode).toBe(200);
    expect(mockClient.find.mock.calls[0][0].limit).toBe(3);
    const body = res.json();
    expect(body).toHaveLength(2);
    const expectedKey = tsKey(4);
    expect(res.headers['x-paging-nextkey']).toBe(expectedKey);
    expect(res.headers['link']).toBe(
      `</flows/flow-1/segments?limit=2&page=${expectedKey}>; rel="next"`
    );
    await app.close();
  });

  it('applies the page cursor as an inclusive lower bound when ascending', async () => {
    mockClient.find.mockResolvedValue({ docs: [] });
    const cursor = '00000000000000000010';

    const app = buildApp(listSegments);
    const res = await app.inject({
      method: 'GET',
      url: `/flows/flow-1/segments?page=${cursor}`
    });

    expect(res.statusCode).toBe(200);
    expect(mockClient.find.mock.calls[0][0].selector.ts_start).toEqual({
      $gte: cursor
    });
    await app.close();
  });

  it('applies the page cursor as an inclusive upper bound when descending', async () => {
    mockClient.find.mockResolvedValue({ docs: [] });
    const cursor = '00000000000000000010';

    const app = buildApp(listSegments);
    const res = await app.inject({
      method: 'GET',
      url: `/flows/flow-1/segments?reverse_order=true&page=${cursor}`
    });

    expect(res.statusCode).toBe(200);
    expect(mockClient.find.mock.calls[0][0].selector.ts_start).toEqual({
      $lte: cursor
    });
    await app.close();
  });

  it('merges the page cursor with an existing timerange bound on ts_start', async () => {
    mockClient.find.mockResolvedValue({ docs: [] });
    const cursor = '00000000000000000010';

    const app = buildApp(listSegments);
    const res = await app.inject({
      method: 'GET',
      url: `/flows/flow-1/segments?timerange=[5:0_15:0)&page=${cursor}`
    });

    expect(res.statusCode).toBe(200);
    // Upper bound from the timerange end plus the lower bound from the cursor.
    expect(mockClient.find.mock.calls[0][0].selector.ts_start).toEqual({
      $lt: '00000000015000000000',
      $gte: cursor
    });
    await app.close();
  });
});
