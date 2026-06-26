import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

vi.mock('../../db/client', () => ({
  flowsClient: { find: vi.fn() },
  sourcesClient: { get: vi.fn(), destroy: vi.fn() }
}));
vi.mock('../../db/withCouchRetry', () => ({
  __esModule: true,
  // Pass-through: run the op once (the retry logic is tested separately).
  default: (op: () => Promise<unknown>) => op()
}));
vi.mock('./notifyWebhooks', () => ({
  __esModule: true,
  default: vi.fn(async () => undefined)
}));

import { flowsClient, sourcesClient } from '../../db/client';
import notifyWebhooks from './notifyWebhooks';
import reclaimSourceIfOrphaned from './reclaimSource';

const flows = flowsClient as unknown as { find: Mock };
const sources = sourcesClient as unknown as { get: Mock; destroy: Mock };
const notify = notifyWebhooks as unknown as Mock;

const notFound = () => Object.assign(new Error('missing'), { statusCode: 404 });

beforeEach(() => {
  vi.clearAllMocks();
  sources.get.mockResolvedValue({ _id: 'src-1', _rev: '1', id: 'src-1' });
  sources.destroy.mockResolvedValue({ ok: true });
  notify.mockResolvedValue(undefined);
});

describe('reclaimSourceIfOrphaned', () => {
  it('deletes the Source and emits sources/deleted when no Flow references it', async () => {
    flows.find.mockResolvedValue({ docs: [] });

    await reclaimSourceIfOrphaned('src-1');

    // Orphan check is scoped to the source_id.
    expect(flows.find.mock.calls[0][0].selector).toEqual({
      source_id: 'src-1'
    });
    expect(sources.destroy).toHaveBeenCalledWith('src-1', '1');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toBe('sources/deleted');
    expect(notify.mock.calls[0][1]).toEqual({ source_id: 'src-1' });
    expect(notify.mock.calls[0][2]).toEqual({ sourceId: 'src-1' });
  });

  it('leaves the Source in place when another Flow still references it', async () => {
    flows.find.mockResolvedValue({ docs: [{ _id: 'other-flow' }] });

    await reclaimSourceIfOrphaned('src-1');

    expect(sources.get).not.toHaveBeenCalled();
    expect(sources.destroy).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('is idempotent on resume: a Source already gone is a no-op (no re-emit)', async () => {
    flows.find.mockResolvedValue({ docs: [] });
    sources.get.mockRejectedValue(notFound());

    await reclaimSourceIfOrphaned('src-1');

    expect(sources.destroy).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('treats a 409 conflict on delete as benign (concurrent writer won, no re-emit)', async () => {
    flows.find.mockResolvedValue({ docs: [] });
    sources.destroy.mockRejectedValue(
      Object.assign(new Error('conflict'), { statusCode: 409 })
    );

    await reclaimSourceIfOrphaned('src-1');

    expect(notify).not.toHaveBeenCalled();
  });

  it('does nothing for an empty source_id', async () => {
    await reclaimSourceIfOrphaned('');

    expect(flows.find).not.toHaveBeenCalled();
    expect(sources.destroy).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('propagates a non-404 error from the Source delete', async () => {
    flows.find.mockResolvedValue({ docs: [] });
    sources.get.mockRejectedValue(
      Object.assign(new Error('boom'), { statusCode: 500 })
    );

    await expect(reclaimSourceIfOrphaned('src-1')).rejects.toThrow('boom');
    expect(notify).not.toHaveBeenCalled();
  });
});
