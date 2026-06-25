import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

vi.mock('../../db/client', () => ({
  segmentsClient: { find: vi.fn(), bulk: vi.fn() },
  flowsClient: { get: vi.fn(), destroy: vi.fn() }
}));
vi.mock('../../db/withCouchRetry', () => ({
  __esModule: true,
  // Pass-through: run the op once (the retry logic is tested separately).
  default: (op: () => Promise<unknown>) => op()
}));
vi.mock('./deleteS3Objects', () => ({
  __esModule: true,
  default: vi.fn(async () => ({ deleted: [], errors: [] }))
}));
vi.mock('./notifyWebhooks', () => ({
  __esModule: true,
  default: vi.fn(async () => undefined)
}));

import { segmentsClient, flowsClient } from '../../db/client';
import deleteS3Objects from './deleteS3Objects';
import notifyWebhooks from './notifyWebhooks';
import performDeletion from './performDeletion';
import { DeletionRequestDoc } from '../../db/schemas/deletion-requests/DeletionRequest';

const segments = segmentsClient as unknown as { find: Mock; bulk: Mock };
const flows = flowsClient as unknown as { get: Mock; destroy: Mock };
const s3Delete = deleteS3Objects as unknown as Mock;
const notify = notifyWebhooks as unknown as Mock;

const ts = (sec: number) =>
  (BigInt(sec) * 1_000_000_000n).toString().padStart(20, '0');

const seg = (n: number, object_id = `bucket/obj-${n}`) => ({
  _id: `s${n}`,
  _rev: '1',
  object_id,
  ts_start: ts(n),
  ts_end: ts(n + 1)
});

// A find implementation that serves the flow_id delete-loop one page per call
// (deleted docs drop out, so we advance through `pages`), and answers the
// reclaim reference check (selector.object_id) with no surviving references.
const scriptPages = (pages: Record<string, unknown>[][]) => {
  let call = 0;
  segments.find.mockImplementation(
    async (q: { selector: { object_id?: string } }) => {
      if ('object_id' in q.selector) return { docs: [] };
      return { docs: pages[call++] ?? [] };
    }
  );
};

const flowDoc = (): DeletionRequestDoc => ({
  _id: 'dr-1',
  id: 'dr-1',
  flow_id: 'flow-1',
  timerange_to_delete: '_',
  delete_flow: true,
  status: 'started',
  created: '2026-06-25T00:00:00.000Z',
  updated: '2026-06-25T00:00:00.000Z'
});

beforeEach(() => {
  vi.clearAllMocks();
  segments.bulk.mockResolvedValue([{ ok: true }]);
  flows.get.mockResolvedValue({ _id: 'flow-1', _rev: '1-abc' });
  flows.destroy.mockResolvedValue({ ok: true });
  s3Delete.mockResolvedValue({ deleted: [], errors: [] });
});

describe('performDeletion (per-batch delete + reclaim)', () => {
  it('deletes each batch and reclaims THAT batch before fetching the next', async () => {
    const BATCH = 1000;
    const page = (start: number, count: number) =>
      Array.from({ length: count }, (_, i) => seg(start + i));
    // Two full pages then a short page -> three batches.
    scriptPages([page(0, BATCH), page(BATCH, BATCH), page(2 * BATCH, 5)]);

    const result = await performDeletion(flowDoc());

    expect(result.deleted).toBe(2 * BATCH + 5);
    // One bulk delete per batch.
    expect(segments.bulk).toHaveBeenCalledTimes(3);
    // One reclaim per batch (NOT a single reclaim at the end). This is the
    // orphan-bug fix: each batch's objects are reclaimed with that batch.
    expect(s3Delete).toHaveBeenCalledTimes(3);
    // Each reclaim call handled only its own batch's objects.
    expect(s3Delete.mock.calls[0][0]).toHaveLength(BATCH);
    expect(s3Delete.mock.calls[1][0]).toHaveLength(BATCH);
    expect(s3Delete.mock.calls[2][0]).toHaveLength(5);
    // Within each batch, the segment docs are deleted BEFORE that batch's
    // objects are reclaimed (reclaim must not count the batch's own segments).
    expect(segments.bulk.mock.invocationCallOrder[0]).toBeLessThan(
      s3Delete.mock.invocationCallOrder[0]
    );
  });

  it('destroys the flow doc and emits flows/deleted only after all batches', async () => {
    scriptPages([[seg(0)]]);

    await performDeletion(flowDoc());

    expect(flows.destroy).toHaveBeenCalledWith('flow-1', '1-abc');
    expect(notify).toHaveBeenCalledWith(
      'flows/deleted',
      { flow_id: 'flow-1' },
      { flowId: 'flow-1' }
    );
    // Flow destroyed after the (only) batch reclaim.
    expect(flows.destroy.mock.invocationCallOrder[0]).toBeGreaterThan(
      s3Delete.mock.invocationCallOrder[0]
    );
  });

  it('leaves no orphaned objects for COMPLETED batches when interrupted mid-run', async () => {
    const BATCH = 1000;
    const page = (start: number, count: number) =>
      Array.from({ length: count }, (_, i) => seg(start + i));
    scriptPages([page(0, BATCH), page(BATCH, BATCH)]);

    // Simulate an interruption: the SECOND batch's reclaim hard-fails (e.g. the
    // pod is torn down / S3 unavailable), which propagates out of performDeletion.
    s3Delete
      .mockResolvedValueOnce({ deleted: [], errors: [] }) // batch 1 reclaim ok
      .mockRejectedValueOnce(new Error('interrupted')); // batch 2 reclaim fails

    await expect(performDeletion(flowDoc())).rejects.toThrow('interrupted');

    // The FIRST (completed) batch already reclaimed its objects before the
    // interruption, so those objects are NOT orphaned. The old code reclaimed
    // only once at the very end, so an interruption orphaned everything.
    expect(s3Delete).toHaveBeenCalledTimes(2);
    expect(s3Delete.mock.calls[0][0]).toHaveLength(BATCH);
    expect(s3Delete.mock.calls[0][0]).toContain('bucket/obj-0');
    // The flow doc is NOT destroyed on an interrupted run, so resume can finish.
    expect(flows.destroy).not.toHaveBeenCalled();
  });

  it('treats an already-deleted flow doc as success (idempotent resume)', async () => {
    scriptPages([[]]); // nothing left to delete on resume
    flows.get.mockRejectedValue({ statusCode: 404 });

    await expect(performDeletion(flowDoc())).resolves.toBeDefined();
    expect(flows.destroy).not.toHaveBeenCalled();
    // Still announces the deletion so subscribers are notified on resume.
    expect(notify).toHaveBeenCalledWith(
      'flows/deleted',
      { flow_id: 'flow-1' },
      { flowId: 'flow-1' }
    );
  });

  it('segment-only delete emits flows/segments_deleted with the deleted span', async () => {
    scriptPages([[seg(0), seg(2)]]);
    const doc: DeletionRequestDoc = {
      ...flowDoc(),
      delete_flow: false,
      timerange_to_delete: '[0:0_4:0)'
    };

    const result = await performDeletion(doc);

    expect(flows.destroy).not.toHaveBeenCalled();
    expect(result.deletedRange).toBe('[0:0_3:0)');
    expect(notify).toHaveBeenCalledWith(
      'flows/segments_deleted',
      { flow_id: 'flow-1', timerange: '[0:0_3:0)' },
      { flowId: 'flow-1' }
    );
  });

  it('segment-only delete with no matches emits no event', async () => {
    scriptPages([[]]);
    const doc: DeletionRequestDoc = {
      ...flowDoc(),
      delete_flow: false,
      timerange_to_delete: '[0:0_4:0)'
    };

    const result = await performDeletion(doc);

    expect(result.deleted).toBe(0);
    expect(segments.bulk).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
