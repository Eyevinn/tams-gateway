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

    // Delete the flow's segment docs in batches, collecting object_id so the
    // underlying media objects can be reclaimed afterwards. A Mango find with no
    // limit returns only CouchDB's default page (25 docs), so a single-shot
    // delete would orphan every segment beyond the first page (and their S3
    // objects). Loop until the flow has no segments left: each batch is deleted
    // before the next find, so the just-deleted docs drop out of the results.
    const BATCH = 1000;
    const objectIds: string[] = [];
    for (;;) {
      const batch = await segmentsClient.find({
        selector: { flow_id: id },
        fields: ['_id', '_rev', 'object_id'],
        limit: BATCH
      });
      if (batch.docs.length === 0) break;
      await segmentsClient.bulk({
        docs: batch.docs.map((doc) => ({
          _id: doc._id,
          _rev: doc._rev,
          _deleted: true
        }))
      });
      for (const doc of batch.docs) {
        if (doc.object_id) objectIds.push(doc.object_id);
      }
      if (batch.docs.length < BATCH) break;
    }

    // Reclaim media objects no surviving segment (in any other flow) still
    // references. Runs after the bulk deletes above so this flow's own segments
    // no longer count as references. Best-effort: a failed object delete is
    // logged, not fatal (the flow and its segment docs are already gone).
    await reclaimUnreferencedObjects(objectIds);

    reply.code(204).send(undefined);
  });
  next();
};

export default deleteFlow;
