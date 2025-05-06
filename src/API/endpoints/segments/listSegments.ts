import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import { segmentsClient } from '../../../DB/client';
import ErrorResponse from '../../utils/error-response';
import Segment from '../../../DB/schemas/segments/Segment';

const SegmentsArray = Type.Array(Segment);

const opts = {
  schema: {
    tags: ['Storage & Segments'],
    description: 'List flow segments',
    response: {
      200: SegmentsArray
    }
  }
};

const ListSegmentsParams = Type.Object({
  id: Type.String()
});

const listSegments: FastifyPluginCallback = (fastify, _, next) => {
  fastify.get<{
    Reply: Static<typeof SegmentsArray | typeof ErrorResponse>;
    Params: Static<typeof ListSegmentsParams>;
  }>('/flows/:id/segments', opts, async (request, reply) => {
    const { id } = request.params;
    const DBSegments = await segmentsClient.get(id);
    const segments = DBSegments.segments;
    reply.code(200).send(segments);
  });
  next();
};

export default listSegments;
