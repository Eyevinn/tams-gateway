import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import { flowsClient } from '../../../DB/client';
import { Flow } from '../../../DB/schemas/flows/Flow';
import ErrorResponse from '../../utils/error-response';

const opts = {
  schema: {
    tags: ['Flows'],
    description: 'Get flow',
    response: {
      200: Flow
    }
  }
};

const GetFlowParams = Type.Object({
  id: Type.String()
});

const getFlow: FastifyPluginCallback = (fastify, _, next) => {
  fastify.get<{
    Reply: Static<typeof Flow | typeof ErrorResponse>;
    Params: Static<typeof GetFlowParams>;
  }>('/flows/:id', opts, async (request, reply) => {
    const DBFlow = await flowsClient.get(request.params.id);

    reply.code(200).send(DBFlow);
  });
  next();
};

export default getFlow;
