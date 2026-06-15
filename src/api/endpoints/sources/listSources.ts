import { Static } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import { sourcesClient } from '../../../db/client';
import ErrorResponse from '../../utils/error-response';
import { Source } from '../../../db/schemas/sources/Source';
import stripDbFields from '../../../db/stripDbFields';

const opts = {
  schema: {
    tags: ['Sources'],
    description: 'List sources'
    // No response schema: sources are returned verbatim (minus _id/_rev) so the
    // response validates against source.json without dropping spec fields.
  }
};

const listSources: FastifyPluginCallback = (fastify, _, next) => {
  fastify.get<{
    Reply: Static<typeof Source>[] | Static<typeof ErrorResponse>;
  }>('/sources', opts, async (_, reply) => {
    const DBSources = await sourcesClient.list({ include_docs: true });
    const sources = DBSources.rows
      .map((row) => row.doc)
      .filter((doc) => !!doc)
      .map((doc) => stripDbFields(doc));

    reply.code(200).send(sources);
  });
  next();
};

export default listSources;
