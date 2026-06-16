import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

vi.mock('../../../db/client', () => ({
  flowsClient: { get: vi.fn(), destroy: vi.fn() },
  segmentsClient: { find: vi.fn(), bulk: vi.fn() }
}));
vi.mock('../../utils/deleteS3Objects', () => ({
  __esModule: true,
  default: vi.fn(async () => ({ deleted: [], errors: [] }))
}));

import { flowsClient, segmentsClient } from '../../../db/client';
import deleteS3Objects from '../../utils/deleteS3Objects';
import deleteFlow from './deleteFlow';

const flows = flowsClient as unknown as { get: Mock; destroy: Mock };
const segments = segmentsClient as unknown as { find: Mock; bulk: Mock };
const s3Delete = deleteS3Objects as unknown as Mock;

const buildApp = (): FastifyInstance => {
  const app = fastify().withTypeProvider<TypeBoxTypeProvider>();
  app.register(deleteFlow);
  return app;
};

// `find` is called twice in delete: first by flow_id to collect segments, then
// once per candidate object_id to check for surviving references. This helper
// scripts those calls in order.
const scriptFind = (
  flowSegments: { _id: string; _rev: string; object_id?: string }[],
  referencesByObjectId: Record<string, number>
) => {
  segments.find.mockReset();
  segments.find.mockImplementation(
    async (query: { selector: Record<string, unknown> }) => {
      if ('flow_id' in query.selector) {
        return { docs: flowSegments };
      }
      const objectId = query.selector.object_id as string;
      const count = referencesByObjectId[objectId] ?? 0;
      return {
        docs: Array.from({ length: count }, (_, i) => ({ _id: `ref-${i}` }))
      };
    }
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  flows.get.mockResolvedValue({ _id: 'flow-1', _rev: '1-abc' });
  flows.destroy.mockResolvedValue({ ok: true });
  segments.bulk.mockResolvedValue([{ ok: true }]);
  s3Delete.mockResolvedValue({ deleted: [], errors: [] });
});

describe('deleteFlow', () => {
  it('deletes the flow doc and bulk-marks its segment docs deleted', async () => {
    scriptFind(
      [
        { _id: 's1', _rev: '1', object_id: 'bucket/obj-1' },
        { _id: 's2', _rev: '1', object_id: 'bucket/obj-2' }
      ],
      {}
    );

    const app = buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/flows/flow-1' });

    expect(res.statusCode).toBe(204);
    expect(flows.destroy).toHaveBeenCalledWith('flow-1', '1-abc');
    const bulkArg = segments.bulk.mock.calls[0][0];
    expect(bulkArg.docs).toEqual([
      { _id: 's1', _rev: '1', _deleted: true },
      { _id: 's2', _rev: '1', _deleted: true }
    ]);
    await app.close();
  });

  it('deletes the underlying S3 objects that no other segment references', async () => {
    scriptFind(
      [
        { _id: 's1', _rev: '1', object_id: 'bucket/obj-1' },
        { _id: 's2', _rev: '1', object_id: 'bucket/obj-2' }
      ],
      // No surviving references to either object.
      { 'bucket/obj-1': 0, 'bucket/obj-2': 0 }
    );

    const app = buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/flows/flow-1' });

    expect(res.statusCode).toBe(204);
    expect(s3Delete).toHaveBeenCalledTimes(1);
    expect(s3Delete.mock.calls[0][0].sort()).toEqual([
      'bucket/obj-1',
      'bucket/obj-2'
    ]);
    await app.close();
  });

  it('does NOT delete an object still referenced by another flow', async () => {
    scriptFind(
      [
        { _id: 's1', _rev: '1', object_id: 'bucket/shared' },
        { _id: 's2', _rev: '1', object_id: 'bucket/private' }
      ],
      // `shared` is still referenced by a segment in another flow; `private` is not.
      { 'bucket/shared': 1, 'bucket/private': 0 }
    );

    const app = buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/flows/flow-1' });

    expect(res.statusCode).toBe(204);
    expect(s3Delete).toHaveBeenCalledTimes(1);
    expect(s3Delete.mock.calls[0][0]).toEqual(['bucket/private']);
    await app.close();
  });

  it('de-duplicates object_ids shared by multiple segments of the deleted flow', async () => {
    scriptFind(
      [
        { _id: 's1', _rev: '1', object_id: 'bucket/obj-1' },
        { _id: 's2', _rev: '1', object_id: 'bucket/obj-1' }
      ],
      { 'bucket/obj-1': 0 }
    );

    const app = buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/flows/flow-1' });

    expect(res.statusCode).toBe(204);
    expect(s3Delete.mock.calls[0][0]).toEqual(['bucket/obj-1']);
    await app.close();
  });

  it('deletes a flow with no segments without touching S3', async () => {
    scriptFind([], {});

    const app = buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/flows/flow-1' });

    expect(res.statusCode).toBe(204);
    expect(segments.bulk).not.toHaveBeenCalled();
    expect(s3Delete).not.toHaveBeenCalled();
    await app.close();
  });

  it('still returns 204 when object reclaim reports per-object errors', async () => {
    scriptFind([{ _id: 's1', _rev: '1', object_id: 'bucket/obj-1' }], {
      'bucket/obj-1': 0
    });
    s3Delete.mockResolvedValue({
      deleted: [],
      errors: [{ object_id: 'bucket/obj-1', message: 'AccessDenied' }]
    });

    const app = buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/flows/flow-1' });

    // The flow + segment docs are already gone; a storage failure is logged,
    // not surfaced as a request failure.
    expect(res.statusCode).toBe(204);
    await app.close();
  });
});
