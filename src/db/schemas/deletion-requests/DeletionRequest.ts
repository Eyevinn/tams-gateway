import { Type, Static } from '@sinclair/typebox';
import DBProperties from '../common/DBProperties';
import stripDbFields from '../../stripDbFields';

// Error detail (TAMS error.json subset), set when status is `error`.
const DeletionRequestError = Type.Object({
  type: Type.String(),
  summary: Type.String(),
  time: Type.String()
});

// Deletion Request (deletion-request.json). Tracks a request to delete a
// timerange of a flow's segments. DELETE /flows/{id} and DELETE
// /flows/{id}/segments create one of these with status `created` and return 202;
// an in-process background worker claims it and runs the per-batch delete +
// reclaim to completion server-side, moving status created -> started -> done
// (or -> error). See src/api/utils/deletionWorker.ts.
export const DeletionRequest = Type.Object({
  id: Type.String(),
  flow_id: Type.String(),
  timerange_to_delete: Type.String(),
  timerange_remaining: Type.Optional(Type.String()),
  delete_flow: Type.Boolean(),
  created: Type.Optional(Type.String()),
  created_by: Type.Optional(Type.String()),
  updated: Type.Optional(Type.String()),
  expiry: Type.Optional(Type.String()),
  status: Type.Union([
    Type.Literal('created'),
    Type.Literal('started'),
    Type.Literal('done'),
    Type.Literal('error')
  ]),
  error: Type.Optional(DeletionRequestError)
});

// Internal, persisted-but-not-spec fields the background worker needs to resume
// and run a request. They are NOT part of the spec deletion-request.json object,
// so the read endpoints strip them (stripWorkerFields) before returning the
// request to clients.
const DeletionRequestWorkerFields = Type.Object({
  // The object_id query filter from DELETE /flows/{id}/segments?object_id=...,
  // if any. The worker re-applies it to the segment selector so a resumed run
  // deletes exactly the same set the request was created for.
  object_id_filter: Type.Optional(Type.String()),
  // The source_id of the flow being deleted (only set for a delete_flow
  // request). Captured at request creation, while the flow doc still exists, so
  // the worker can reclaim a now-orphaned Source after destroying the flow even
  // on a resumed run where the flow doc is already gone. See performDeletion.
  source_id: Type.Optional(Type.String())
});

export const DBDeletionRequest = Type.Intersect([
  DeletionRequest,
  DeletionRequestWorkerFields,
  DBProperties
]);

export type DeletionRequestDoc = Static<typeof DBDeletionRequest>;

// The internal worker-only field names (not part of deletion-request.json).
export const WORKER_ONLY_FIELDS = ['object_id_filter', 'source_id'] as const;

// Project a persisted request doc to the spec deletion-request.json object:
// drop CouchDB bookkeeping (_id/_rev) and the internal worker-only fields, so a
// client only ever sees the spec shape. Used by the DELETE handlers' 202 body
// and the flow-delete-requests read endpoints.
export const stripDeletionRequest = <T extends object>(
  doc: T
): Record<string, unknown> => {
  const copy = stripDbFields(doc) as Record<string, unknown>;
  for (const field of WORKER_ONLY_FIELDS) delete copy[field];
  return copy;
};

// Build the persisted request doc for a new deletion (status `created`).
// Centralised here, the lightweight schema module, so the DELETE handlers do not
// pull in the worker (and its S3/AWS import chain) just to construct a doc. The
// worker and the handlers share this shape, including the worker-only
// object_id_filter that is stripped from client responses.
export const buildDeletionRequestDoc = (input: {
  id: string;
  flow_id: string;
  timerange_to_delete: string;
  delete_flow: boolean;
  object_id_filter?: string;
  source_id?: string;
  created_by?: string;
}): DeletionRequestDoc => {
  const now = new Date().toISOString();
  return {
    _id: input.id,
    id: input.id,
    flow_id: input.flow_id,
    timerange_to_delete: input.timerange_to_delete,
    delete_flow: input.delete_flow,
    status: 'created',
    created: now,
    updated: now,
    ...(input.object_id_filter
      ? { object_id_filter: input.object_id_filter }
      : {}),
    ...(input.source_id ? { source_id: input.source_id } : {}),
    ...(input.created_by ? { created_by: input.created_by } : {})
  };
};
