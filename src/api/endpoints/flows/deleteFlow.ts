import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import { flowsClient, segmentsClient } from '../../../db/client';
import { Flow } from '../../../db/schemas/flows/Flow';
import ErrorResponse from '../../utils/error-response';
import reclaimUnreferencedObjects from '../../utils/reclaimObjects';
import notifyWebhooks from '../../utils/notifyWebhooks';
import withCouchRetry from '../../../db/withCouchRetry';

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
    const DBFlow = await withCouchRetry(() => flowsClient.get(id));

    // Delete the flow's segments and reclaim their media objects BEFORE
    // destroying the flow doc. If any of this fails (e.g. a transient CouchDB
    // 503), the flow doc still exists, so the client can simply retry the
    // DELETE and the operation resumes; the flow is only removed once its
    // storage has actually been cleaned up. Destroying the flow first (the
    // previous order) orphaned the segments and S3 objects with no way to reach
    // them again when reclaim failed part-way.
    //
    // Batched delete: a Mango find with no limit returns only CouchDB's default
    // page (25 docs), so a single-shot delete would orphan every segment beyond
    // the first page. Loop until the flow has no segments left; each batch is
    // deleted before the next find, so the just-deleted docs drop out of the
    // results. Every CouchDB call is retried on transient 503/429.
    const BATCH = 1000;
    const objectIds: string[] = [];
    for (;;) {
      const batch = await withCouchRetry(() =>
        segmentsClient.find({
          selector: { flow_id: id },
          fields: ['_id', '_rev', 'object_id'],
          limit: BATCH
        })
      );
      if (batch.docs.length === 0) break;
      await withCouchRetry(() =>
        segmentsClient.bulk({
          docs: batch.docs.map((doc) => ({
            _id: doc._id,
            _rev: doc._rev,
            _deleted: true
          }))
        })
      );
      for (const doc of batch.docs) {
        if (doc.object_id) objectIds.push(doc.object_id);
      }
      if (batch.docs.length < BATCH) break;
    }

    // Reclaim media objects no surviving segment (in any other flow) still
    // references. Runs after the bulk deletes above so this flow's own segments
    // no longer count as references. Best-effort: a failed object delete is
    // logged, not fatal.
    await reclaimUnreferencedObjects(objectIds);

    // Storage is clean: now remove the flow doc and announce the deletion.
    await withCouchRetry(() => flowsClient.destroy(DBFlow._id, DBFlow._rev));
    await notifyWebhooks('flows/deleted', { flow_id: id }, { flowId: id });

    reply.code(204).send(undefined);
  });
  next();
};

export default deleteFlow;
