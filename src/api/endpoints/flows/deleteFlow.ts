import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import { flowsClient, segmentsClient } from '../../../db/client';
import { Flow } from '../../../db/schemas/flows/Flow';
import ErrorResponse from '../../utils/error-response';
import deleteS3Objects from '../../utils/deleteS3Objects';
import Logger from '../../../utils/Logger';
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

// A media object can be referenced by Flow Segments in more than one Flow (see
// the TAMS Object schema's `referenced_by_flows`). Return the subset of the
// given object_ids that no remaining (non-deleted) segment references, so the
// caller only reclaims storage that has become genuinely unreachable.
const findUnreferencedObjects = async (
  objectIds: string[]
): Promise<string[]> => {
  const unreferenced: string[] = [];
  for (const objectId of objectIds) {
    // Deleted segments are already excluded from Mango results, so any hit here
    // is a live reference (in this or another flow) and the object must stay.
    const stillReferenced = await segmentsClient.find({
      selector: { object_id: objectId },
      fields: ['_id'],
      limit: 1
    });
    if (stillReferenced.docs.length === 0) {
      unreferenced.push(objectId);
    }
  }
  return unreferenced;
};

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

    // Candidate object_ids to reclaim (de-duplicated, since one object may back
    // several of this flow's segments).
    const candidateObjectIds = [
      ...new Set(
        segments.docs
          .map((doc) => doc.object_id)
          .filter((objectId): objectId is string => Boolean(objectId))
      )
    ];

    if (candidateObjectIds.length > 0) {
      // Only delete objects that no surviving segment (in any other flow) still
      // references. This runs after the bulk delete above so this flow's own
      // segments no longer count as references.
      const unreferenced = await findUnreferencedObjects(candidateObjectIds);
      if (unreferenced.length > 0) {
        const { errors } = await deleteS3Objects(unreferenced);
        // Storage reclaim is best-effort: the flow and its segment docs are
        // already gone, so a failed object delete must not fail the request.
        // Log it so the leak is visible and recoverable rather than silent.
        for (const error of errors) {
          Logger.red(
            `Failed to delete media object ${error.object_id}: ${error.message}`
          );
        }
      }
    }

    reply.code(204).send(undefined);
  });
  next();
};

export default deleteFlow;
