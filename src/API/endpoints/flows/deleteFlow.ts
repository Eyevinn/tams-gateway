import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import { flowsClient } from '../../../DB/client';
import { Flow } from '../../../DB/schemas/flows/Flow';
import ErrorResponse from '../../utils/error-response';

const opts = {
  schema: {
    tags: ['Flows'],
    description: 'Delete flow'
  }
};

const DeleteFlowParams = Type.Object({
  id: Type.String()
});

const deleteFlow: FastifyPluginCallback = (fastify, _, next) => {
  fastify.delete<{
    Reply: Static<typeof Flow | typeof ErrorResponse>;
    Params: Static<typeof DeleteFlowParams>;
  }>('/flows/:id', opts, async (request, reply) => {
    const DBFlow = await flowsClient.get(request.params.id);
    flowsClient.destroy(DBFlow._id, DBFlow._rev);

    reply.code(204).send();
  });
  next();
};

export default deleteFlow;
