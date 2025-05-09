import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import ErrorResponse from '../../utils/error-response';
import Segment from '../../../DB/schemas/segments/Segment';
import { segmentsClient } from '../../../DB/client';

const PostSegmentsErrorBody = Type.Intersect([
  ErrorResponse,
  Type.Object({ id: Type.String() })
]);

const PostSegmentsBody = Segment;

const PostSegmentsReply = Type.Array(Segment);

const PostSegmentsParams = Type.Object({
  id: Type.String()
});

const opts = {
  schema: {
    tags: ['Storage & Segments'],
    description: 'Post segments to storage',
    body: PostSegmentsBody,
    response: {
      200: PostSegmentsReply
    }
  }
};

// Store segment data to database
const postSegments: FastifyPluginCallback = (fastify, _, next) => {
  fastify.post<{
    Body: Static<typeof PostSegmentsBody>;
    Reply: Static<typeof PostSegmentsReply | typeof PostSegmentsErrorBody>;
    Params: Static<typeof PostSegmentsParams>;
  }>('/flows/:id/segments', opts, async (request, reply) => {
    const { id } = request.params;
    const { object_id } = request.body;

    const DBSegments = await segmentsClient.get(id);

    const segmentExists = DBSegments.segments.find(
      (segment) => segment.object_id === object_id
    );

    let newSegments;
    if (segmentExists) {
      newSegments = DBSegments.segments.map((segment) => {
        if (segment.object_id !== object_id) {
          return segment;
        } else {
          return {
            ...segment,
            ...request.body
          };
        }
      });
    } else {
      newSegments = [...DBSegments.segments, request.body];
    }

    const newDBSegments = {
      ...DBSegments,
      segments: newSegments
    };
    await segmentsClient.insert(newDBSegments);

    reply.code(200).send(newSegments);
  });
  next();
};

export default postSegments;
