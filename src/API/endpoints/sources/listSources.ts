import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import { sourcesClient } from '../../../DB/client';
import ErrorResponse from '../../utils/error-response';
import { Source } from '../../../DB/schemas/sources/Source';

const Sources = Type.Array(Source);

const opts = {
  schema: {
    tags: ['Sources'],
    description: 'List flows',
    response: {
      200: Sources
    }
  }
};

const listSources: FastifyPluginCallback = (fastify, _, next) => {
  fastify.get<{
    Reply: Static<typeof Sources | typeof ErrorResponse>;
  }>('/sources', opts, async (_, reply) => {
    const DBSources = await sourcesClient.list({ include_docs: true });
    const sources: Static<typeof Sources> = DBSources.rows
      .map((DBSource) => {
        return DBSource.doc;
      })
      .filter((source) => !!source);

    reply.code(200).send(sources);
  });
  next();
};

export default listSources;
