import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import { flowsClient, segmentsClient } from '../../../db/client';
import { Flow } from '../../../db/schemas/flows/Flow';
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
    Reply: Static<typeof Flow | typeof ErrorResponse> | undefined;
    Params: Static<typeof DeleteFlowParams>;
  }>('/flows/:id', opts, async (request, reply) => {
    const { id } = request.params;
    const DBFlow = await flowsClient.get(id);
    await flowsClient.destroy(DBFlow._id, DBFlow._rev);

    // Remove the flow's segment documents.
    const segments = await segmentsClient.find({
      selector: { flow_id: id },
      fields: ['_id', '_rev']
    });
    if (segments.docs.length > 0) {
      await segmentsClient.bulk({
        docs: segments.docs.map((doc) => ({
          _id: doc._id,
          _rev: doc._rev,
          _deleted: true
        }))
      });
    }

    reply.code(204).send(undefined);
  });
  next();
};

export default deleteFlow;
