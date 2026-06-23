import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import Segment from '../../../db/schemas/segments/Segment';
import { segmentsClient } from '../../../db/client';
import { segmentKeys } from '../../utils/timerange';
import getOrUndefined from '../../../db/getOrUndefined';
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

// Register each segment as its own CouchDB document. The deterministic _id makes
// re-posting the same segment idempotent (upsert) rather than appending.
// Returns 201 when every segment is stored, or 200 with the list of failures
// (continuing past failures, per the spec) when some could not be registered.
const postSegments: FastifyPluginCallback = (fastify, _, next) => {
  fastify.post<{
    Body: Static<typeof PostSegmentsBody>;
    Reply: Static<typeof FailedSegments> | undefined;
    Params: Static<typeof PostSegmentsParams>;
  }>('/flows/:id/segments', opts, async (request, reply) => {
    const { id } = request.params;
    const body = request.body;
    const segments = Array.isArray(body) ? body : [body];

    const failed: Static<typeof FailedSegments>['failed_segments'] = [];
    // Successfully registered segments, emitted in the flows/segments_added event.
    const registered: Static<typeof Segment>[] = [];

    for (const entry of segments) {
      // get_urls are presigned on read, never stored (dropped here).
      const { get_urls: _getUrls, ...segment } = entry;
      try {
        const { tsStart, tsEnd } = segmentKeys(segment.timerange);
        const _id = `${id}:${tsStart}:${segment.object_id}`;

        // Reuse the existing revision so a re-post upserts rather than conflicts.
        const existing = await getOrUndefined(segmentsClient, _id);
        const _rev = existing?._rev;

        await segmentsClient.insert({
          ...segment,
          _id,
          ...(_rev ? { _rev } : {}),
          flow_id: id,
          ts_start: tsStart,
          ts_end: tsEnd
        });
        registered.push(segment);
      } catch (err) {
        failed.push({
          object_id: segment.object_id,
          timerange: segment.timerange,
          error: {
            type: 'RegistrationError',
            summary: err instanceof Error ? err.message : String(err),
            time: new Date().toISOString()
          }
        });
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
