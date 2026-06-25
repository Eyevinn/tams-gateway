import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import { MangoSelector } from 'nano';
import { v4 as uuidv4 } from 'uuid';
import {
  segmentsClient,
  flowsClient,
  deletionRequestsClient
} from '../../../db/client';
import ErrorResponse from '../../utils/error-response';
import httpError from '../../utils/http-error';
import { parseTimeRange, toKey, formatTimeRange } from '../../utils/timerange';
import reclaimUnreferencedObjects from '../../utils/reclaimObjects';
import notifyWebhooks from '../../utils/notifyWebhooks';
import withCouchRetry from '../../../db/withCouchRetry';

const opts = {
  schema: {
    tags: ['Storage & Segments'],
    description:
      'Delete flow segments completely covered by the given timerange',
    querystring: {
      type: 'object',
      properties: {
        timerange: { type: 'string', default: '_' },
        object_id: { type: 'string' }
      }
    }
  }
};

const DeleteSegmentsParams = Type.Object({
  id: Type.String()
});

const DeleteSegmentsQueries = Type.Object({
  timerange: Type.Optional(Type.String()),
  object_id: Type.Optional(Type.String())
});

// Batch size for the delete loop. Deletion runs synchronously: each batch is
// removed before the next is fetched, so an unbounded number of segments is
// handled across iterations rather than capped at a single page. (Very large
// deletions would benefit from the spec's async 202 + Flow Delete Request
// worker model, which is a follow-up.)
const BATCH = 1000;

// Delete a flow's segments that are COMPLETELY COVERED by the timerange (spec
// semantics: containment, not overlap). ts_start must be at/after the query
// start and ts_end at/before the query end.
const deleteSegments: FastifyPluginCallback = (fastify, _, next) => {
  fastify.delete<{
    Reply: Static<typeof ErrorResponse> | undefined;
    Params: Static<typeof DeleteSegmentsParams>;
    Querystring: Static<typeof DeleteSegmentsQueries>;
  }>('/flows/:id/segments', opts, async (request, reply) => {
    const { id } = request.params;
    const { timerange = '_', object_id } = request.query;

    // (1) Flow must exist -> 404.
    let flow;
    try {
      flow = await flowsClient.get(id);
    } catch (e: unknown) {
      if ((e as { statusCode?: number }).statusCode === 404) {
        throw httpError(404, `Flow "${id}" not found`);
      }
      throw e;
    }

    // (2) A read-only flow may not be modified -> 403.
    if (flow.read_only) {
      throw httpError(403, `Flow "${id}" is read-only`);
    }

    // (3) Containment selector. An unparseable timerange (or one whose bounds
    // exceed the key width) is a client error, not a 500. toKey is inside the
    // try because it throws on an out-of-range timestamp.
    const selector: MangoSelector = { flow_id: id };
    try {
      const range = parseTimeRange(timerange);
      if (range.start !== null) {
        // Segment must START at/after the query start (strict if exclusive).
        selector.ts_start = {
          [range.startInclusive ? '$gte' : '$gt']: toKey(range.start)
        };
      }
      if (range.end !== null) {
        // Segment's exclusive END must be at/before the query end: [x, ts_end)
        // is contained in the query range when ts_end <= query end.
        selector.ts_end = { $lte: toKey(range.end) };
      }
    } catch {
      throw httpError(400, `Invalid timerange "${timerange}"`);
    }
    if (object_id) {
      selector.object_id = object_id;
    }

    // (4) Delete in batches until none remain, tracking the reclaimable objects
    // and the actual deleted span (for the event timerange).
    const objectIds = new Set<string>();
    let deleted = 0;
    let firstStart: bigint | null = null;
    let lastEnd: bigint | null = null;
    for (;;) {
      const batch = await withCouchRetry(() =>
        segmentsClient.find({
          selector,
          fields: ['_id', '_rev', 'object_id', 'ts_start', 'ts_end'],
          limit: BATCH
        })
      );
      if (batch.docs.length === 0) break;
      await withCouchRetry(() =>
        segmentsClient.bulk({
          docs: batch.docs.map((doc) => ({
            _id: doc._id,
            _rev: doc._rev,
            _deleted: true
          }))
        })
      );
      for (const doc of batch.docs) {
        if (doc.object_id) objectIds.add(doc.object_id);
        const start = BigInt(doc.ts_start);
        const end = BigInt(doc.ts_end);
        if (firstStart === null || start < firstStart) firstStart = start;
        if (lastEnd === null || end > lastEnd) lastEnd = end;
      }
      deleted += batch.docs.length;
      if (batch.docs.length < BATCH) break;
    }

    // (5) Reclaim now-unreferenced media objects, record the deletion, and emit
    // the event, only when something was actually deleted (the event timerange
    // MUST intersect a deleted segment, per the spec).
    if (deleted > 0 && firstStart !== null && lastEnd !== null) {
      await reclaimUnreferencedObjects([...objectIds]);

      const deletedRange = formatTimeRange({
        start: firstStart,
        end: lastEnd,
        startInclusive: true,
        endInclusive: false
      });
      const now = new Date().toISOString();
      const requestId = uuidv4();
      await deletionRequestsClient.insert({
        _id: requestId,
        id: requestId,
        flow_id: id,
        timerange_to_delete: deletedRange,
        delete_flow: false,
        status: 'done',
        created: now,
        updated: now
      });

      await notifyWebhooks(
        'flows/segments_deleted',
        { flow_id: id, timerange: deletedRange },
        { flowId: id }
      );
    }

    // The segments have been deleted synchronously.
    reply.code(204).send(undefined);
  });
  next();
};

export default deleteSegments;
