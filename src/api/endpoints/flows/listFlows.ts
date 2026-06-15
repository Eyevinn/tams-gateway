import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import { MangoSelector } from 'nano';
import { flowsClient } from '../../../db/client';
import { Flow } from '../../../db/schemas/flows/Flow';
import ErrorResponse from '../../utils/error-response';

const Flows = Type.Array(Flow);

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
    querystring: ListFlowsQueries,
    response: {
      200: Flows
    }
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
    Reply: Static<typeof Flows | typeof ErrorResponse>;
    Querystring: Static<typeof ListFlowsQueries>;
  }>('/flows', opts, async (request, reply) => {
    const selector = buildSelector(request.query as Record<string, unknown>);

    let flows: Static<typeof Flows>;
    if (selector) {
      const result = await flowsClient.find({ selector, limit: FIND_LIMIT });
      flows = result.docs as unknown as Static<typeof Flows>;
    } else {
      const DBFlows = await flowsClient.list({ include_docs: true });
      flows = DBFlows.rows
        .map((row) => row.doc)
        .filter((doc) => !!doc) as Static<typeof Flows>;
    }

    reply.code(200).send(flows);
  });
  next();
};

export default listFlows;
