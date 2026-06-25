import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import Segment from '../../../db/schemas/segments/Segment';
import { DBSegment } from '../../../db/schemas/segments/Segments';
import { segmentsClient } from '../../../db/client';
import { segmentKeys } from '../../utils/timerange';
import withCouchRetry from '../../../db/withCouchRetry';
import notifyWebhooks from '../../utils/notifyWebhooks';

// A single segment or an array of segments, per the TAMS spec.
const PostSegmentsBody = Type.Union([Segment, Type.Array(Segment)]);

// Error object (TAMS `error.json`) describing why a segment failed to register.
const SegmentError = Type.Object({
  type: Type.String(),
  summary: Type.String(),
  time: Type.String()
});

// 200 response body: the segments that could not be registered.
const FailedSegments = Type.Object({
  failed_segments: Type.Array(
    Type.Object({
      object_id: Type.String(),
      timerange: Type.Optional(Type.String()),
      error: Type.Optional(SegmentError)
    })
  )
});

const PostSegmentsParams = Type.Object({
  id: Type.String()
});

const opts = {
  schema: {
    tags: ['Storage & Segments'],
    description: 'Register one segment or an array of segments for a flow',
    body: PostSegmentsBody,
    response: {
      // Partial success: some segments failed to register. Full success is 201
      // with no body (not declared here, as an empty body needs no schema).
      200: FailedSegments
    }
  }
};

type FailedSegment = Static<typeof FailedSegments>['failed_segments'][number];
type SegmentDoc = Static<typeof DBSegment>;

// A segment whose document was computed successfully and is queued for the bulk
// write. `segment` is the request entry minus get_urls (the shape emitted in
// the flows/segments_added event); `doc` is the stored CouchDB document.
interface PreparedSegment {
  doc: SegmentDoc;
  segment: Static<typeof Segment>;
  object_id: string;
  timerange: string;
}

const registrationError = (
  object_id: string,
  timerange: string | undefined,
  message: string
): FailedSegment => ({
  object_id,
  ...(timerange !== undefined ? { timerange } : {}),
  error: {
    type: 'RegistrationError',
    summary: message,
    time: new Date().toISOString()
  }
});

// Register a batch of segments with bulk CouchDB I/O instead of a per-segment
// get-then-insert loop. The deterministic _id (`<flow>:<ts_start>:<object_id>`)
// makes a re-post an idempotent upsert rather than an append.
//
// The loop the gateway used before did 2N sequential round-trips (a GET to read
// the current _rev, then a PUT) for N segments, which made a 500-segment POST
// take ~22s even though CouchDB itself can absorb tens of thousands of docs per
// second through _bulk_docs. It also 409'd when recreating a segment whose _id
// had been deleted: a plain GET returns 404 for a tombstone, so the insert ran
// without the tombstone's _rev and conflicted. This handler instead:
//   1. computes every doc once,
//   2. fetches the current _rev for ALL ids in one _all_docs keys request
//      (which returns the rev even for a DELETED/tombstoned id), so an upsert or
//      a recreate-after-delete carries the right _rev and never 409s, and
//   3. writes every doc in one _bulk_docs request.
// Per-doc bulk errors are mapped back to failed_segments so a partial failure
// degrades to 200 exactly as before.
//
// Returns 201 (no body) when every segment is stored, or 200 with the list of
// failures (continuing past failures, per the spec) when some could not be
// registered.
const postSegments: FastifyPluginCallback = (fastify, _, next) => {
  fastify.post<{
    Body: Static<typeof PostSegmentsBody>;
    Reply: Static<typeof FailedSegments> | undefined;
    Params: Static<typeof PostSegmentsParams>;
  }>('/flows/:id/segments', opts, async (request, reply) => {
    const { id } = request.params;
    const body = request.body;
    const segments = Array.isArray(body) ? body : [body];

    const failed: FailedSegment[] = [];
    const prepared: PreparedSegment[] = [];

    // Compute each document. A bad timerange fails only its own segment; the
    // rest of the batch proceeds.
    for (const entry of segments) {
      // get_urls are presigned on read, never stored (dropped here).
      const { get_urls: _getUrls, ...segment } = entry;
      try {
        const { tsStart, tsEnd } = segmentKeys(segment.timerange);
        prepared.push({
          object_id: segment.object_id,
          timerange: segment.timerange,
          segment,
          doc: {
            ...segment,
            _id: `${id}:${tsStart}:${segment.object_id}`,
            flow_id: id,
            ts_start: tsStart,
            ts_end: tsEnd
          }
        });
      } catch (err) {
        failed.push(
          registrationError(
            segment.object_id,
            segment.timerange,
            err instanceof Error ? err.message : String(err)
          )
        );
      }
    }

    // Successfully registered segments, emitted in the flows/segments_added event.
    const registered: Static<typeof Segment>[] = [];

    if (prepared.length > 0) {
      try {
        // Two ids in one batch can collapse to the same _id (same flow, start
        // and object). _bulk_docs rejects duplicate _ids within one request, so
        // keep the last write per _id and key the existing-rev lookup by _id.
        const byId = new Map<string, PreparedSegment>();
        for (const p of prepared) {
          byId.set(p.doc._id, p);
        }
        const ids = [...byId.keys()];

        // Fetch the current revision for every id in one request. _all_docs
        // returns a row for a tombstoned id with value.deleted === true and the
        // tombstone's rev, which we must reuse so a recreate-after-delete does
        // not 409. A never-existed id comes back as an error row (not_found)
        // with no value, which we skip so the doc is inserted without a _rev.
        const existing = await withCouchRetry(() =>
          segmentsClient.list({ keys: ids })
        );

        const revById = new Map<string, string>();
        for (const row of existing.rows) {
          const value = (row as { value?: { rev?: string } }).value;
          if (row.id && value?.rev) {
            revById.set(row.id, value.rev);
          }
        }

        const docs = [...byId.values()].map(({ doc }) => {
          const rev = revById.get(doc._id);
          return rev ? { ...doc, _rev: rev } : doc;
        });

        const results = await withCouchRetry(() =>
          segmentsClient.bulk({ docs })
        );

        // Map each per-doc result back to its prepared segment by index: bulk
        // preserves the order of the docs it was given.
        results.forEach((result, index) => {
          const p = docs[index];
          const source = byId.get(p._id);
          if (!source) return;
          if (result.error) {
            failed.push(
              registrationError(
                source.object_id,
                source.timerange,
                result.reason || result.error
              )
            );
          } else {
            registered.push(source.segment);
          }
        });
      } catch (err) {
        // The bulk fetch or write failed as a whole (e.g. CouchDB unreachable
        // after retries). Every prepared segment in the batch failed.
        const message = err instanceof Error ? err.message : String(err);
        for (const p of prepared) {
          failed.push(registrationError(p.object_id, p.timerange, message));
        }
      }
    }

    // Emit the segments-added notification for the segments that registered
    // (never throws). Skip when none succeeded.
    if (registered.length > 0) {
      await notifyWebhooks(
        'flows/segments_added',
        { flow_id: id, segments: registered },
        { flowId: id }
      );
    }

    if (failed.length > 0) {
      reply.code(200).send({ failed_segments: failed });
    } else {
      reply.code(201).send(undefined);
    }
  });
  next();
};

export default postSegments;
