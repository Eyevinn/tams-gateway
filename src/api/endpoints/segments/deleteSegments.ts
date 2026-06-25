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
import { parseTimeRange } from '../../utils/timerange';

const opts = {
  schema: {
    tags: ['Storage & Segments'],
    description:
      'Delete flow segments completely covered by the given timerange',
    querystring: {
      type: 'object',
      properties: {
        timerange: { type: 'string', default: '_' },
        object_id: { type: 'string' }
      }
    }
  }
};

const DeleteSegmentsParams = Type.Object({
  id: Type.String()
});

const DeleteSegmentsQueries = Type.Object({
  timerange: Type.Optional(Type.String()),
  object_id: Type.Optional(Type.String())
});

// Asynchronous delete of a flow's segments completely covered by the timerange
// (spec semantics: containment, not overlap). Like DELETE /flows/{id}, a large
// deletion exceeds the OSC ingress request timeout, so we persist a Flow Delete
// Request (status `created`) and return 202 with a Location header; the
// in-process deletion worker runs the per-batch delete + reclaim server-side.
// See spec DELETE_flows-flowId-segments: "If the deletion takes too long then
// this request will return 202 Accepted and the `Location` header will point to
// a Flow Delete Request to monitor deletion progress".
const deleteSegments: FastifyPluginCallback = (fastify, _, next) => {
  fastify.delete<{
    Reply: Static<typeof ErrorResponse> | Record<string, unknown> | undefined;
    Params: Static<typeof DeleteSegmentsParams>;
    Querystring: Static<typeof DeleteSegmentsQueries>;
  }>('/flows/:id/segments', opts, async (request, reply) => {
    const { id } = request.params;
    const { timerange = '_', object_id } = request.query;

    // (1) Flow must exist -> 404.
    let flow;
    try {
      flow = await flowsClient.get(id);
    } catch (e: unknown) {
      if ((e as { statusCode?: number }).statusCode === 404) {
        throw httpError(404, `Flow "${id}" not found`);
      }
      throw e;
    }

    // (2) A read-only flow may not be modified -> 403.
    if (flow.read_only) {
      throw httpError(403, `Flow "${id}" is read-only`);
    }

    // (3) Validate the timerange up front so an unparseable value is a 400 now,
    //     not an async error later. The worker re-parses the stored value.
    try {
      parseTimeRange(timerange);
    } catch {
      throw httpError(400, `Invalid timerange "${timerange}"`);
    }

    // (4) Persist the request and return 202; the worker does the work.
    const requestId = uuidv4();
    const doc = buildDeletionRequestDoc({
      id: requestId,
      flow_id: id,
      timerange_to_delete: timerange,
      delete_flow: false,
      object_id_filter: object_id
    });
    await deletionRequestsClient.insert(doc);

    reply
      .code(202)
      .header('Location', `/flow-delete-requests/${requestId}`)
      .send(stripDeletionRequest(doc));
  });
  next();
};

export default deleteSegments;
