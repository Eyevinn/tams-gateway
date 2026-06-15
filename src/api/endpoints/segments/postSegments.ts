import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import ErrorResponse from '../../utils/error-response';
import Segment from '../../../db/schemas/segments/Segment';
import { segmentsClient } from '../../../db/client';
import { segmentKeys } from '../../utils/timerange';

const PostSegmentsErrorBody = Type.Intersect([
  ErrorResponse,
  Type.Object({ id: Type.String() })
]);

const PostSegmentsBody = Segment;

const PostSegmentsReply = Segment;

const PostSegmentsParams = Type.Object({
  id: Type.String()
});

const opts = {
  schema: {
    tags: ['Storage & Segments'],
    description: 'Register a segment for a flow',
    body: PostSegmentsBody,
    response: {
      201: PostSegmentsReply
    }
  }
};

// Register a segment as its own CouchDB document. The deterministic _id makes
// re-posting the same segment idempotent (upsert) rather than appending.
const postSegments: FastifyPluginCallback = (fastify, _, next) => {
  fastify.post<{
    Body: Static<typeof PostSegmentsBody>;
    Reply: Static<typeof PostSegmentsReply | typeof PostSegmentsErrorBody>;
    Params: Static<typeof PostSegmentsParams>;
  }>('/flows/:id/segments', opts, async (request, reply) => {
    const { id } = request.params;
    // get_urls are presigned on read, never stored (dropped from the body here).
    const { get_urls: _getUrls, ...segment } = request.body;
    const { tsStart, tsEnd } = segmentKeys(segment.timerange);
    const _id = `${id}:${tsStart}:${segment.object_id}`;

    let _rev: string | undefined;
    try {
      const existing = await segmentsClient.get(_id);
      _rev = existing._rev;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      if (e.statusCode !== 404) {
        throw e;
      }
    }

    await segmentsClient.insert({
      ...segment,
      _id,
      ...(_rev ? { _rev } : {}),
      flow_id: id,
      ts_start: tsStart,
      ts_end: tsEnd
    });

    reply.code(201).send(segment);
  });
  next();
};

export default postSegments;
