import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { flowsClient, deletionRequestsClient } from '../../../db/client';
import ErrorResponse from '../../utils/error-response';
import httpError from '../../utils/http-error';
import {
  buildDeletionRequestDoc,
  stripDeletionRequest
} from '../../../db/schemas/deletion-requests/DeletionRequest';

const opts = {
  schema: {
    tags: ['Flows'],
    description: 'Delete flow'
  }
};

const DeleteFlowParams = Type.Object({
  id: Type.String()
});

// Asynchronous delete (TAMS spec). Deleting a flow with many segments takes
// longer than the OSC ingress request timeout (~50-60s), so we do NOT delete
// synchronously: we persist a Flow Delete Request (status `created`) and return
// 202 with a Location header pointing at the request, and the in-process
// deletion worker (started in server.ts) runs the per-batch delete + reclaim to
// completion server-side. See spec DELETE_flows-flowId: "If Flow Segment
// deletion takes too long then this request will return 202 Accepted and the
// `Location` header will point to a Flow Delete Request to monitor deletion
// progress".
const deleteFlow: FastifyPluginCallback = (fastify, _, next) => {
  fastify.delete<{
    Reply: Static<typeof ErrorResponse> | Record<string, unknown> | undefined;
    Params: Static<typeof DeleteFlowParams>;
  }>('/flows/:id', opts, async (request, reply) => {
    const { id } = request.params;

    // Flow must exist -> 404. (Read-only flows are still deletable: read_only
    // guards content mutation, not deletion of the flow itself.)
    let sourceId: string | undefined;
    try {
      const flow = await flowsClient.get(id);
      // Capture source_id now, while the flow doc still exists, so the worker
      // can reclaim a now-orphaned Source after destroying the flow even on a
      // resumed run (which may execute long after this, when the flow is gone).
      sourceId = flow.source_id;
    } catch (e: unknown) {
      if ((e as { statusCode?: number }).statusCode === 404) {
        throw httpError(404, `Flow "${id}" not found`);
      }
      throw e;
    }

    const requestId = uuidv4();
    const doc = buildDeletionRequestDoc({
      id: requestId,
      flow_id: id,
      // The whole flow: an open ("_") timerange covers every segment.
      timerange_to_delete: '_',
      delete_flow: true,
      source_id: sourceId
    });
    await deletionRequestsClient.insert(doc);

    reply
      .code(202)
      .header('Location', `/flow-delete-requests/${requestId}`)
      .send(stripDeletionRequest(doc));
  });
  next();
};

export default deleteFlow;
