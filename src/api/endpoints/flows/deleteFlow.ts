import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import { flowsClient, segmentsClient } from '../../../db/client';
import { Flow } from '../../../db/schemas/flows/Flow';
import ErrorResponse from '../../utils/error-response';
import reclaimUnreferencedObjects from '../../utils/reclaimObjects';
import notifyWebhooks from '../../utils/notifyWebhooks';

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

    // Emit the flow-deleted notification (never throws).
    await notifyWebhooks('flows/deleted', { flow_id: id }, { flowId: id });

    // Collect the flow's segments, keeping object_id so the underlying media
    // objects can be reclaimed after the segment docs are removed.
    const segments = await segmentsClient.find({
      selector: { flow_id: id },
      fields: ['_id', '_rev', 'object_id']
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

    // Reclaim media objects no surviving segment (in any other flow) still
    // references. Runs after the bulk delete above so this flow's own segments
    // no longer count as references. Best-effort: a failed object delete is
    // logged, not fatal (the flow and its segment docs are already gone).
    await reclaimUnreferencedObjects(
      segments.docs.map((doc) => doc.object_id).filter(Boolean) as string[]
    );

    reply.code(204).send(undefined);
  });
  next();
};

export default deleteFlow;
