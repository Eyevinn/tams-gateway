import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import { MangoSelector } from 'nano';
import { segmentsClient } from '../../../db/client';
import ErrorResponse from '../../utils/error-response';
import Segment from '../../../db/schemas/segments/Segment';
import createS3URL from '../../utils/createS3URL';
import { overlapBounds, formatTimeRange } from '../../utils/timerange';
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
        reverse_order: { type: 'boolean', default: false },
        // Opaque paging cursor (trait_resource_paged_key): the ts_start key of
        // the first segment of the requested page, as returned in a prior
        // response's X-Paging-NextKey / Link header.
        page: { type: 'string' }
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
  reverse_order: Type.Optional(Type.Boolean()),
  page: Type.Optional(Type.String())
});

// Build the relative "next page" URL, preserving the active query params and
// swapping in the new cursor. Returned in the Link header per the TAMS paging
// trait (clients SHOULD follow Link rel="next").
const nextPageUrl = (
  id: string,
  query: Static<typeof ListSegmentsQueries>,
  nextKey: string
): string => {
  const params = new URLSearchParams();
  if (query.timerange) params.set('timerange', query.timerange);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.reverse_order) params.set('reverse_order', 'true');
  params.set('page', nextKey);
  return `/flows/${id}/segments?${params.toString()}`;
};

// The timerange spanned by a page of segments (X-Paging-Timerange), derived from
// the smallest ts_start and largest ts_end among the returned docs. ts_start /
// ts_end are 20-digit zero-padded nanosecond keys, so BigInt(key) recovers the
// nanosecond count and lexicographic min/max equals numeric min/max.
const pagingTimerange = (
  docs: { ts_start: string; ts_end: string }[]
): string => {
  let minStart = BigInt(docs[0].ts_start);
  let maxEnd = BigInt(docs[0].ts_end);
  for (const doc of docs) {
    const start = BigInt(doc.ts_start);
    const end = BigInt(doc.ts_end);
    if (start < minStart) minStart = start;
    if (end > maxEnd) maxEnd = end;
  }
  return formatTimeRange({
    start: minStart,
    end: maxEnd,
    startInclusive: true,
    endInclusive: false
  });
};

// Fetch a flow's segments, filtered by timerange via the Mango index rather
// than loading every segment and filtering in memory. Paged with an opaque
// ts_start cursor: one extra row is fetched to detect whether a next page
// exists, and its ts_start becomes the next cursor (X-Paging-NextKey / Link).
const listSegments: FastifyPluginCallback = (fastify, _, next) => {
  fastify.get<{
    Reply: Static<typeof SegmentsArray | typeof ErrorResponse>;
    Params: Static<typeof ListSegmentsParams>;
    Querystring: Static<typeof ListSegmentsQueries>;
  }>('/flows/:id/segments', opts, async (request, reply) => {
    const { id } = request.params;
    const { timerange, limit, reverse_order, page } = request.query;

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

    // Apply the paging cursor as a bound on ts_start, merged with any timerange
    // bound on the same field. Ascending pages move forward (ts_start >= cursor);
    // descending pages move backward (ts_start <= cursor). The cursor is the
    // ts_start of the first segment of this page, so it is inclusive.
    if (page) {
      const cursorOp = reverse_order ? '$lte' : '$gte';
      selector.ts_start = {
        ...(selector.ts_start as Record<string, string> | undefined),
        [cursorOp]: page
      };
    }

    const max = limit ?? DEFAULT_LIMIT;
    // Fetch one extra row to detect a following page without a second query.
    const result = await segmentsClient.find({
      selector,
      sort: [{ flow_id: dir }, { ts_start: dir }],
      limit: max + 1
    });

    const hasMore = result.docs.length > max;
    const pageDocs = hasMore ? result.docs.slice(0, max) : result.docs;
    // The next cursor is the first segment NOT included in this page, so
    // following it yields the next page with neither a gap nor (for distinct
    // ts_start values) a repeat.
    const nextKey = hasMore ? result.docs[max].ts_start : undefined;

    const segments = await Promise.all(
      pageDocs.map(async (doc) => ({
        object_id: doc.object_id,
        timerange: doc.timerange,
        sample_count: doc.sample_count,
        sample_offset: doc.sample_offset,
        get_urls: [{ url: await createS3URL('GET', doc.object_id) }]
      }))
    );

    reply.header('X-Paging-Limit', String(max));
    reply.header('X-Paging-Count', String(pageDocs.length));
    reply.header('X-Paging-Reverse-Order', String(Boolean(reverse_order)));
    // Best-effort: every gateway-stored segment carries ts_start/ts_end, but
    // skip the span header rather than fail the request if one somehow lacks them.
    if (pageDocs.length > 0 && pageDocs[0].ts_start && pageDocs[0].ts_end) {
      reply.header('X-Paging-Timerange', pagingTimerange(pageDocs));
    }
    if (nextKey) {
      reply.header('X-Paging-NextKey', nextKey);
      reply.header(
        'Link',
        `<${nextPageUrl(id, request.query, nextKey)}>; rel="next"`
      );
    }

    reply.code(200).send(segments);
  });
  next();
};

export default listSegments;
