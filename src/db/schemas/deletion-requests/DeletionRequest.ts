import { Type, Static } from '@sinclair/typebox';
import DBProperties from '../common/DBProperties';

// Error detail (TAMS error.json subset), set when status is `error`.
const DeletionRequestError = Type.Object({
  type: Type.String(),
  summary: Type.String(),
  time: Type.String()
});

// Deletion Request (deletion-request.json). Tracks a request to delete a
// timerange of a flow's segments. This gateway deletes synchronously, so a
// persisted request is recorded with status `done`; the async `started` model
// (202 + Location) is a follow-up.
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

export const DBDeletionRequest = Type.Intersect([
  DeletionRequest,
  DBProperties
]);

export type DeletionRequestDoc = Static<typeof DBDeletionRequest>;
