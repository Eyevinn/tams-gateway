import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

vi.mock('../../db/client', () => ({
  segmentsClient: { find: vi.fn() }
}));
vi.mock('./deleteS3Objects', () => ({
  __esModule: true,
  default: vi.fn(async () => ({ deleted: [], errors: [] }))
}));
vi.mock('../../utils/Logger', () => ({
  __esModule: true,
  default: { red: vi.fn() }
}));

import { segmentsClient } from '../../db/client';
import deleteS3Objects from './deleteS3Objects';
import reclaimUnreferencedObjects from './reclaimObjects';

const find = segmentsClient.find as unknown as Mock;
const s3Delete = deleteS3Objects as unknown as Mock;

// Mock CouchDB Mango against a `referenced` map (object_id -> how many surviving
// segments reference it). Honours the $in selector and the limit exactly as
// CouchDB would, so we can exercise the page-limit "crowding" path.
const mockReferenced = (referenced: Record<string, number>) => {
  find.mockImplementation(
    async (q: {
      selector: { object_id: { $in: string[] } };
      limit: number;
    }) => {
      const ids = q.selector.object_id.$in;
      const docs: { object_id: string }[] = [];
      for (const id of ids) {
        for (let n = 0; n < (referenced[id] ?? 0); n++) {
          docs.push({ object_id: id });
        }
      }
      return { docs: docs.slice(0, q.limit) };
    }
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  s3Delete.mockResolvedValue({ deleted: [], errors: [] });
});

describe('reclaimUnreferencedObjects', () => {
  it('reclaims every object in one query when none are still referenced', async () => {
    mockReferenced({});
    await reclaimUnreferencedObjects(['b/o1', 'b/o2', 'b/o3']);

    // One $in query for the whole batch (not one per object).
    expect(find).toHaveBeenCalledTimes(1);
    expect(find.mock.calls[0][0].selector.object_id.$in).toEqual([
      'b/o1',
      'b/o2',
      'b/o3'
    ]);
    expect(s3Delete).toHaveBeenCalledTimes(1);
    expect(s3Delete.mock.calls[0][0].sort()).toEqual(['b/o1', 'b/o2', 'b/o3']);
  });

  it('never reclaims an object that a surviving segment still references', async () => {
    // o2 is referenced by another flow's segment; o1 and o3 are not.
    mockReferenced({ 'b/o2': 1 });
    await reclaimUnreferencedObjects(['b/o1', 'b/o2', 'b/o3']);

    expect(s3Delete).toHaveBeenCalledTimes(1);
    const reclaimed = s3Delete.mock.calls[0][0].sort();
    expect(reclaimed).toEqual(['b/o1', 'b/o3']);
    expect(reclaimed).not.toContain('b/o2');
  });

  it('does not reclaim a referenced object even when another object crowds the page limit (no data loss)', async () => {
    // o1 has 5 segments; with limit === batch size (3) it fills the first page
    // entirely, so o2 (1 segment, also referenced) is crowded out of round 1.
    // The shrinking-$in loop must still never reclaim o2.
    mockReferenced({ 'b/o1': 5, 'b/o2': 1 });
    await reclaimUnreferencedObjects(['b/o1', 'b/o2', 'b/o3']);

    expect(s3Delete).toHaveBeenCalledTimes(1);
    const reclaimed = s3Delete.mock.calls[0][0];
    // Only the genuinely unreferenced o3 is reclaimed; o1 and o2 survive.
    expect(reclaimed).toEqual(['b/o3']);
    expect(reclaimed).not.toContain('b/o1');
    expect(reclaimed).not.toContain('b/o2');
    // It took more than one round to resolve the crowded set, but terminated.
    expect(find.mock.calls.length).toBeGreaterThan(1);
  });

  it('does nothing (no query, no delete) for an empty / falsy-only input', async () => {
    await reclaimUnreferencedObjects([]);
    expect(find).not.toHaveBeenCalled();
    expect(s3Delete).not.toHaveBeenCalled();
  });

  it('de-duplicates object_ids before checking', async () => {
    mockReferenced({});
    await reclaimUnreferencedObjects(['b/o1', 'b/o1', 'b/o2']);
    expect(find.mock.calls[0][0].selector.object_id.$in).toEqual([
      'b/o1',
      'b/o2'
    ]);
    expect(s3Delete.mock.calls[0][0].sort()).toEqual(['b/o1', 'b/o2']);
  });
});
