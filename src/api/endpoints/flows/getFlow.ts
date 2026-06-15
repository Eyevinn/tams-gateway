import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import { flowsClient } from '../../../db/client';
import { Flow } from '../../../db/schemas/flows/Flow';
import ErrorResponse from '../../utils/error-response';
import stripDbFields from '../../../db/stripDbFields';

const opts = {
  schema: {
    tags: ['Flows'],
    description: 'Get flow'
    // No response schema: the stored Flow is returned verbatim (minus _id/_rev)
    // so every spec field is preserved and the response validates against
    // flow.json. A narrower schema would silently drop format-specific fields.
  }
};

const GetFlowParams = Type.Object({
  id: Type.String()
});

const getFlow: FastifyPluginCallback = (fastify, _, next) => {
  fastify.get<{
    Reply: Static<typeof Flow> | Static<typeof ErrorResponse>;
    Params: Static<typeof GetFlowParams>;
  }>('/flows/:id', opts, async (request, reply) => {
    const flow = await flowsClient.get(request.params.id);

    reply.code(200).send(stripDbFields(flow));
  });
  next();
};

export default getFlow;
