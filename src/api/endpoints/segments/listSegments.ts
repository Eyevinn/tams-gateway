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
        limit: { type: 'integer', minimum: 0 },
        reverse_order: { type: 'boolean', default: false }
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
  limit: Type.Optional(Type.Integer()),
  // BBC TAMS standard param: return segments newest-first. Also lets a client
  // discover the flow's latest segment cheaply with reverse_order=true&limit=1.
  reverse_order: Type.Optional(Type.Boolean())
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
    const { timerange, limit, reverse_order } = request.query;

    const selector: MangoSelector = { flow_id: id };
    if (timerange) {
      let bounds: ReturnType<typeof overlapBounds>;
      try {
        bounds = overlapBounds(timerange);
      } catch {
        // An unparseable timerange is a client error, not a server error.
        throw httpError(400, `Invalid timerange "${timerange}"`);
      }
      // A stored segment [ts_start, ts_end) overlaps the query when ts_start
      // is at/before the query end (inclusive end => $lte, exclusive => $lt)
      // and ts_end is strictly after the query start. See overlapBounds for
      // why the ts_end side is always strict ($gt).
      if (bounds.startBelow !== null) {
        selector.ts_start = { [bounds.startOp]: bounds.startBelow };
      }
      if (bounds.endAbove !== null) {
        selector.ts_end = { [bounds.endOp]: bounds.endAbove };
      }
    }

    // CouchDB requires a uniform sort direction across all fields; both ascend
    // or both descend so the [flow_id, ts_start] index can be read forward or in
    // reverse without an in-memory sort.
    const dir = reverse_order ? 'desc' : 'asc';
    const result = await segmentsClient.find({
      selector,
      sort: [{ flow_id: dir }, { ts_start: dir }],
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
