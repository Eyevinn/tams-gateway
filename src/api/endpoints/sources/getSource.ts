import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import { sourcesClient } from '../../../db/client';
import getOrUndefined from '../../../db/getOrUndefined';
import stripDbFields from '../../../db/stripDbFields';
import httpError from '../../utils/http-error';

const opts = {
  schema: {
    tags: ['Sources'],
    description: 'Get a source'
    // No response schema: the source is returned verbatim (minus _id/_rev) so it
    // validates against source.json without dropping spec fields.
  }
};

const GetSourceParams = Type.Object({
  id: Type.String()
});

const getSource: FastifyPluginCallback = (fastify, _, next) => {
  fastify.get<{ Params: Static<typeof GetSourceParams> }>(
    '/sources/:id',
    opts,
    async (request, reply) => {
      const doc = await getOrUndefined(sourcesClient, request.params.id);
      if (!doc) {
        throw httpError(404, `Source "${request.params.id}" not found`);
      }
      reply.code(200).send(stripDbFields(doc));
    }
  );
  next();
};

export default getSource;
