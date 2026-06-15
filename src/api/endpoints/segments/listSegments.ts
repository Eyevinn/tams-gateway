import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import { MangoSelector } from 'nano';
import { segmentsClient } from '../../../db/client';
import ErrorResponse from '../../utils/error-response';
import Segment from '../../../db/schemas/segments/Segment';
import createS3URL from '../../utils/createS3URL';
import { overlapBounds } from '../../utils/timerange';
import httpError from '../../utils/http-error';

const SegmentsArray = Type.Array(Segment);

const DEFAULT_LIMIT = 1000;

const opts = {
  schema: {
    tags: ['Storage & Segments'],
    description: 'List flow segments',
    querystring: {
      type: 'object',
      properties: {
        timerange: { type: 'string' },
        limit: { type: 'integer', minimum: 0 }
      }
    },
    response: {
      200: SegmentsArray
    }
  }
};

const ListSegmentsParams = Type.Object({
  id: Type.String()
});

const ListSegmentsQueries = Type.Object({
  timerange: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer())
});

// Fetch a flow's segments, filtered by timerange via the Mango index rather
// than loading every segment and filtering in memory.
const listSegments: FastifyPluginCallback = (fastify, _, next) => {
  fastify.get<{
    Reply: Static<typeof SegmentsArray | typeof ErrorResponse>;
    Params: Static<typeof ListSegmentsParams>;
    Querystring: Static<typeof ListSegmentsQueries>;
  }>('/flows/:id/segments', opts, async (request, reply) => {
    const { id } = request.params;
    const { timerange, limit } = request.query;

    const selector: MangoSelector = { flow_id: id };
    if (timerange) {
      let bounds: ReturnType<typeof overlapBounds>;
      try {
        bounds = overlapBounds(timerange);
      } catch {
        // An unparseable timerange is a client error, not a server error.
        throw httpError(400, `Invalid timerange "${timerange}"`);
      }
      // Segment overlaps query when ts_start < queryEnd && ts_end > queryStart.
      if (bounds.startBelow !== null) {
        selector.ts_start = { $lt: bounds.startBelow };
      }
      if (bounds.endAbove !== null) {
        selector.ts_end = { $gt: bounds.endAbove };
      }
    }

    const result = await segmentsClient.find({
      selector,
      sort: [{ flow_id: 'asc' }, { ts_start: 'asc' }],
      limit: limit ?? DEFAULT_LIMIT
    });

    const segments = await Promise.all(
      result.docs.map(async (doc) => ({
        object_id: doc.object_id,
        timerange: doc.timerange,
        sample_count: doc.sample_count,
        sample_offset: doc.sample_offset,
        get_urls: [{ url: await createS3URL('GET', doc.object_id) }]
      }))
    );

    reply.code(200).send(segments);
  });
  next();
};

export default listSegments;
