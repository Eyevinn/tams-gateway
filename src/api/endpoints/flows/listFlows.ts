import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import { MangoSelector } from 'nano';
import { flowsClient } from '../../../db/client';
import { Flow } from '../../../db/schemas/flows/Flow';
import ErrorResponse from '../../utils/error-response';
import stripDbFields from '../../../db/stripDbFields';

// Interim cap for filtered queries until cursor pagination is added; the
// unfiltered listing still returns every flow.
const FIND_LIMIT = 1000;

const ListFlowsQueries = Type.Object(
  {
    source_id: Type.Optional(Type.String()),
    format: Type.Optional(Type.String()),
    codec: Type.Optional(Type.String()),
    label: Type.Optional(Type.String()),
    frame_width: Type.Optional(Type.Integer()),
    frame_height: Type.Optional(Type.Integer())
  },
  // tag.{name} and tag_exists.{name} are dynamic keys handled in the handler.
  { additionalProperties: true }
);

const opts = {
  schema: {
    tags: ['Flows'],
    description: 'List flows, optionally filtered by the spec query parameters',
    querystring: ListFlowsQueries
    // No response schema: flows are returned verbatim (minus _id/_rev) so the
    // response validates against flow.json without dropping spec fields.
  }
};

// Translate the supported query filters into a Mango selector. Returns null when
// no filters are present so the caller can use a plain (unbounded) listing.
const buildSelector = (
  query: Record<string, unknown>
): MangoSelector | null => {
  const selector: MangoSelector = {};

  const scalarFields = ['source_id', 'format', 'codec', 'label'];
  for (const field of scalarFields) {
    const value = query[field];
    if (typeof value === 'string' && value !== '') {
      selector[field] = value;
    }
  }

  if (typeof query.frame_width === 'number') {
    selector['essence_parameters.frame_width'] = query.frame_width;
  }
  if (typeof query.frame_height === 'number') {
    selector['essence_parameters.frame_height'] = query.frame_height;
  }

  for (const [key, value] of Object.entries(query)) {
    if (key.startsWith('tag.')) {
      selector[`tags.${key.slice('tag.'.length)}`] = String(value);
    } else if (key.startsWith('tag_exists.')) {
      selector[`tags.${key.slice('tag_exists.'.length)}`] = {
        $exists: value === 'true' || value === true
      };
    }
  }

  return Object.keys(selector).length > 0 ? selector : null;
};

const listFlows: FastifyPluginCallback = (fastify, _, next) => {
  fastify.get<{
    Reply: Static<typeof Flow>[] | Static<typeof ErrorResponse>;
    Querystring: Static<typeof ListFlowsQueries>;
  }>('/flows', opts, async (request, reply) => {
    const selector = buildSelector(request.query as Record<string, unknown>);

    let docs: object[];
    if (selector) {
      const result = await flowsClient.find({ selector, limit: FIND_LIMIT });
      docs = result.docs;
    } else {
      // _all_docs (nano list) includes CouchDB design documents (Mango indexes
      // live at _design/* in the same database). They are not Flows, so drop
      // them; otherwise an index doc leaks into GET /flows as a bogus entry.
      // (The find() path above cannot return them: they match no field selector.)
      const DBFlows = await flowsClient.list({ include_docs: true });
      docs = DBFlows.rows
        .filter((row) => !row.id.startsWith('_design/'))
        .map((row) => row.doc)
        .filter((doc) => !!doc);
    }

    reply
      .code(200)
      .send(docs.map((doc) => stripDbFields(doc)) as Static<typeof Flow>[]);
  });
  next();
};

export default listFlows;
