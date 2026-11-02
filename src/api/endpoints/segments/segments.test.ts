import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import fastify, { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

vi.mock('../../../db/client', () => ({
  segmentsClient: {
    get: vi.fn(),
    insert: vi.fn(),
    find: vi.fn(),
    // POST _all_docs keys lookup for existing revisions, then the bulk write.
    fetchRevs: vi.fn(),
    bulk: vi.fn()
  },
  // Flow record holding the per-flow longest-segment bound.
  flowsClient: { get: vi.fn(), insert: vi.fn() },
  // notifyWebhooks queries this; no subscribers in these tests.
  webhooksClient: { find: vi.fn().mockResolvedValue({ docs: [] }) }
}));
vi.mock('../../utils/createS3URL', () => ({
  __esModule: true,
  default: vi.fn(async () => 'https://s3.example/signed')
}));

import { segmentsClient, flowsClient } from '../../../db/client';
import postSegments from './postSegments';
import listSegments from './listSegments';

const mockClient = segmentsClient as unknown as {
  get: Mock;
  insert: Mock;
  find: Mock;
  fetchRevs: Mock;
  bulk: Mock;
};

const mockFlows = flowsClient as unknown as { get: Mock; insert: Mock };

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
  // By default the flow record does not exist (404), so no bound applies and
  // nothing is recorded; tests that care install a flow with mockFlow().
  mockFlows.get.mockReset();
  mockFlows.get.mockRejectedValue({ statusCode: 404 });
  mockFlows.insert.mockReset();
  mockFlows.insert.mockResolvedValue({ ok: true, rev: '2-x' });
});

const SEC = 1_000_000_000n;
const key = (sec: number | bigint) =>
  (BigInt(sec) * SEC).toString().padStart(20, '0');

// Install a flow record; maxSec undefined means no recorded maximum yet.
const mockFlow = (maxSec?: number) =>
  mockFlows.get.mockResolvedValue({
    _id: 'flow-1',
    _rev: '1-a',
    id: 'flow-1',
    source_id: 's',
    format: 'urn:x-nmos:format:video',
    ...(maxSec === undefined
      ? {}
      : { max_segment_duration_ns: (BigInt(maxSec) * SEC).toString() })
  });

describe('postSegments', () => {
  it('upserts a new segment with derived flow_id and keys', async () => {
    const id = 'flow-1:00000000000000000000:bucket/obj-1';
    mockClient.fetchRevs.mockResolvedValue(allDocsResponse([id]));
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
    mockClient.fetchRevs.mockResolvedValue(
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
    mockClient.fetchRevs.mockResolvedValue(
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
    mockClient.fetchRevs.mockResolvedValue(allDocsResponse(ids));
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
    expect(mockClient.fetchRevs).toHaveBeenCalledTimes(1);
    expect(mockClient.bulk).toHaveBeenCalledTimes(1);
    expect(mockClient.fetchRevs.mock.calls[0][0].keys).toEqual(ids);
    expect(mockClient.bulk.mock.calls[0][0].docs).toHaveLength(2);
    await app.close();
  });

  it('returns 200 with the failed segments on partial failure', async () => {
    const ids = [
      'flow-1:00000000000000000000:bucket/obj-1',
      'flow-1:00000000010000000000:bucket/obj-2'
    ];
    mockClient.fetchRevs.mockResolvedValue(allDocsResponse(ids));
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
    mockClient.fetchRevs.mockResolvedValue(allDocsResponse([goodId]));
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
    mockClient.fetchRevs.mockResolvedValue(allDocsResponse([id]));
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

// A minimal Mango evaluator (equality, $lt/$lte/$gt/$gte on string keys, sort by
// ts_start, limit) so the tests check which segments a query actually returns.
const storedSegment = (id: string, startSec: number, durSec: number) => ({
  object_id: id,
  timerange: `[${startSec}:0_${startSec + durSec}:0)`,
  flow_id: 'flow-1',
  ts_start: key(startSec),
  ts_end: key(startSec + durSec)
});

const useStore = (docs: ReturnType<typeof storedSegment>[]) => {
  mockClient.find.mockImplementation(
    async ({
      selector,
      sort,
      limit
    }: {
      selector: Record<string, unknown>;
      sort: Array<Record<string, string>>;
      limit: number;
    }) => {
      const cmp: Record<string, (a: string, b: string) => boolean> = {
        $lt: (a, b) => a < b,
        $lte: (a, b) => a <= b,
        $gt: (a, b) => a > b,
        $gte: (a, b) => a >= b
      };
      const rows = docs.filter((doc) =>
        Object.entries(selector).every(([field, cond]) => {
          const v = (doc as Record<string, string>)[field];
          if (typeof cond !== 'object' || cond === null) return v === cond;
          return Object.entries(cond as Record<string, string>).every(
            ([op, bound]) => cmp[op](v, bound)
          );
        })
      );
      const desc = sort?.[1]?.ts_start === 'desc';
      rows.sort((a, b) =>
        desc
          ? b.ts_start.localeCompare(a.ts_start)
          : a.ts_start.localeCompare(b.ts_start)
      );
      return { docs: rows.slice(0, limit) };
    }
  );
};

describe('listSegments lookback bound', () => {
  const list = async (query: string) => {
    const app = buildApp(listSegments);
    const res = await app.inject({
      method: 'GET',
      url: `/flows/flow-1/segments?${query}`
    });
    await app.close();
    return res;
  };
  const ids = (res: { json: () => Array<{ object_id: string }> }) =>
    res.json().map((s) => s.object_id);
  const selectorOf = () => mockClient.find.mock.calls[0][0].selector;

  // Longest stored segment is 100 s (the spanning one); window is [150, 160).
  const fixture = () =>
    useStore([
      storedSegment('spanning', 0, 100),
      storedSegment('long-after-start', 80, 100),
      storedSegment('before', 100, 10),
      storedSegment('touches-start', 140, 10),
      storedSegment('inside', 152, 2),
      storedSegment('at-end', 160, 2),
      storedSegment('after', 170, 10)
    ]);

  it('adds ts_start >= window start - longest to the query', async () => {
    mockFlow(100);
    useStore([]);
    await list('timerange=[150:0_160:0)');
    expect(selectorOf().ts_start).toEqual({
      $lt: key(160),
      $gte: key(50)
    });
    expect(selectorOf().ts_end).toEqual({ $gt: key(150) });
  });

  it('returns exactly the overlapping segments, including a long one that starts well before the window', async () => {
    mockFlow(100);
    fixture();
    const res = await list('timerange=[150:0_160:0)');
    expect(ids(res)).toEqual(['long-after-start', 'inside']);
  });

  it('returns the same segments without a recorded maximum (unbounded fallback)', async () => {
    mockFlow(undefined);
    fixture();
    const res = await list('timerange=[150:0_160:0)');
    expect(selectorOf().ts_start).toEqual({ $lt: key(160) });
    expect(ids(res)).toEqual(['long-after-start', 'inside']);
  });

  it('falls back to the unbounded query when the flow record is missing', async () => {
    fixture();
    const res = await list('timerange=[150:0_160:0)');
    expect(res.statusCode).toBe(200);
    expect(selectorOf().ts_start).toEqual({ $lt: key(160) });
  });

  it('keeps a segment starting exactly at the bound and drops one ending exactly at the window start', async () => {
    mockFlow(10);
    useStore([
      // Starts exactly at window start - longest, ends 1 ns after window start.
      {
        ...storedSegment('edge-in', 90, 10),
        ts_end: key(100).replace(/0$/, '1')
      },
      // Ends exactly at the window start: no overlap.
      storedSegment('edge-out', 90, 10)
    ]);
    const res = await list('timerange=[100:0_110:0)');
    expect(selectorOf().ts_start).toEqual({ $lt: key(110), $gte: key(90) });
    expect(ids(res)).toEqual(['edge-in']);
  });

  it('omits the bound when it would fall at or before the epoch', async () => {
    mockFlow(1000);
    useStore([]);
    await list('timerange=[5:0_15:0)');
    expect(selectorOf().ts_start).toEqual({ $lt: key(15) });
  });

  it('applies no bound and reads no flow for an open-start window', async () => {
    mockFlow(100);
    useStore([]);
    await list('timerange=_15:0)');
    expect(selectorOf().ts_start).toEqual({ $lt: key(15) });
    expect(mockFlows.get).not.toHaveBeenCalled();
  });

  it('reads no flow without a timerange', async () => {
    mockFlow(100);
    useStore([]);
    await list('limit=5');
    expect(mockFlows.get).not.toHaveBeenCalled();
  });

  it('works with reverse_order', async () => {
    mockFlow(100);
    fixture();
    const res = await list('timerange=[150:0_160:0)&reverse_order=true');
    expect(selectorOf().ts_start).toEqual({ $lt: key(160), $gte: key(50) });
    expect(ids(res)).toEqual(['inside', 'long-after-start']);
  });

  it('keeps the lookback bound when the page cursor is below it (ascending)', async () => {
    mockFlow(100);
    useStore([]);
    await list(`timerange=[150:0_160:0)&page=${key(10)}`);
    expect(selectorOf().ts_start).toEqual({ $lt: key(160), $gte: key(50) });
  });

  it('uses the page cursor when it is above the lookback bound (ascending)', async () => {
    mockFlow(100);
    useStore([]);
    await list(`timerange=[150:0_160:0)&page=${key(152)}`);
    expect(selectorOf().ts_start).toEqual({ $lt: key(160), $gte: key(152) });
  });

  it('keeps the lookback bound alongside a descending cursor', async () => {
    mockFlow(100);
    useStore([]);
    await list(`timerange=[150:0_160:0)&reverse_order=true&page=${key(152)}`);
    expect(selectorOf().ts_start).toEqual({
      $lt: key(160),
      $gte: key(50),
      $lte: key(152)
    });
  });

  it('does not let a descending cursor widen an inclusive-end window', async () => {
    mockFlow(100);
    useStore([]);
    await list(`timerange=[150:0_160:0]&reverse_order=true&page=${key(999)}`);
    expect(selectorOf().ts_start.$lte).toBe(key(160));
  });
});

describe('postSegments records the longest segment duration', () => {
  const post = async (payload: unknown) => {
    const app = buildApp(postSegments);
    const res = await app.inject({
      method: 'POST',
      url: '/flows/flow-1/segments',
      payload: payload as object
    });
    await app.close();
    return res;
  };
  const okBulk = () => {
    mockClient.fetchRevs.mockImplementation(
      async ({ keys }: { keys: string[] }) => allDocsResponse(keys)
    );
    mockClient.bulk.mockImplementation(async ({ docs }) => bulkOk(docs));
  };
  const insertedMax = () => mockFlows.insert.mock.calls.at(-1)?.[0];

  it('records the batch maximum on a new flow, before the segments are written', async () => {
    okBulk();
    mockFlow(undefined);
    mockClient.find.mockResolvedValue({ docs: [] });
    const res = await post([
      { object_id: 'a', timerange: '[0:0_2:0)' },
      { object_id: 'b', timerange: '[2:0_12:0)' }
    ]);
    expect(res.statusCode).toBe(201);
    expect(insertedMax().max_segment_duration_ns).toBe((10n * SEC).toString());
    expect(mockFlows.insert.mock.invocationCallOrder[0]).toBeLessThan(
      mockClient.bulk.mock.invocationCallOrder[0]
    );
  });

  it('includes an older, longer stored segment when no maximum was recorded yet', async () => {
    okBulk();
    mockFlow(undefined);
    mockClient.find.mockResolvedValue({
      docs: [
        { ts_start: key(0), ts_end: key(60) },
        { ts_start: key(60), ts_end: key(62) }
      ]
    });
    await post({ object_id: 'a', timerange: '[100:0_102:0)' });
    expect(insertedMax().max_segment_duration_ns).toBe((60n * SEC).toString());
  });

  it('pages through the stored segments when scanning', async () => {
    okBulk();
    mockFlow(undefined);
    const page = (n: number, durSec: number) =>
      Array.from({ length: n }, () => ({
        ts_start: key(0),
        ts_end: key(durSec)
      }));
    mockClient.find
      .mockResolvedValueOnce({ docs: page(1000, 2), bookmark: 'b1' })
      .mockResolvedValueOnce({ docs: page(3, 30), bookmark: 'b2' });
    await post({ object_id: 'a', timerange: '[100:0_102:0)' });
    expect(mockClient.find).toHaveBeenCalledTimes(2);
    expect(mockClient.find.mock.calls[1][0].bookmark).toBe('b1');
    expect(insertedMax().max_segment_duration_ns).toBe((30n * SEC).toString());
  });

  it('does not write the flow for a segment no longer than the recorded maximum', async () => {
    okBulk();
    mockFlow(10);
    const res = await post({ object_id: 'a', timerange: '[0:0_10:0)' });
    expect(res.statusCode).toBe(201);
    expect(mockFlows.insert).not.toHaveBeenCalled();
    expect(mockClient.find).not.toHaveBeenCalled();
  });

  it('raises the maximum for a longer segment', async () => {
    okBulk();
    mockFlow(10);
    await post({ object_id: 'a', timerange: '[0:0_30:0)' });
    expect(insertedMax().max_segment_duration_ns).toBe((30n * SEC).toString());
  });

  it('re-reads on a conflict and never lowers a value raised concurrently', async () => {
    okBulk();
    mockFlows.get
      .mockResolvedValueOnce({
        _id: 'flow-1',
        _rev: '1-a',
        max_segment_duration_ns: (5n * SEC).toString()
      })
      .mockResolvedValueOnce({
        _id: 'flow-1',
        _rev: '2-b',
        max_segment_duration_ns: (60n * SEC).toString()
      });
    mockFlows.insert.mockRejectedValueOnce({ statusCode: 409 });
    const res = await post({ object_id: 'a', timerange: '[0:0_10:0)' });
    expect(res.statusCode).toBe(201);
    // The concurrent writer's larger value already covers this segment.
    expect(mockFlows.insert).toHaveBeenCalledTimes(1);
    expect(mockClient.bulk).toHaveBeenCalled();
  });

  it('retries a conflict with the fresh revision', async () => {
    okBulk();
    mockFlows.get
      .mockResolvedValueOnce({
        _id: 'flow-1',
        _rev: '1-a',
        max_segment_duration_ns: '5'
      })
      .mockResolvedValueOnce({
        _id: 'flow-1',
        _rev: '2-b',
        max_segment_duration_ns: '7'
      });
    mockFlows.insert.mockRejectedValueOnce({ statusCode: 409 });
    await post({ object_id: 'a', timerange: '[0:0_10:0)' });
    expect(mockFlows.insert).toHaveBeenCalledTimes(2);
    expect(mockFlows.insert.mock.calls[1][0]._rev).toBe('2-b');
    expect(insertedMax().max_segment_duration_ns).toBe((10n * SEC).toString());
  });

  it('fails the batch without writing segments when the maximum cannot be recorded', async () => {
    okBulk();
    mockFlow(1);
    mockFlows.insert.mockRejectedValue({ statusCode: 409 });
    const res = await post({ object_id: 'a', timerange: '[0:0_10:0)' });
    expect(res.statusCode).toBe(200);
    expect(res.json().failed_segments).toHaveLength(1);
    expect(mockClient.bulk).not.toHaveBeenCalled();
  });

  it('still registers segments when the flow record does not exist', async () => {
    okBulk();
    const res = await post({ object_id: 'a', timerange: '[0:0_10:0)' });
    expect(res.statusCode).toBe(201);
    expect(mockFlows.insert).not.toHaveBeenCalled();
    expect(mockClient.bulk).toHaveBeenCalled();
  });
});
