import { Type, Static } from '@sinclair/typebox';
import DBProperties from '../common/DBProperties';

// The 8 TAMS event types a webhook may subscribe to (webhook.json `events`).
export const WEBHOOK_EVENTS = [
  'flows/created',
  'flows/updated',
  'flows/deleted',
  'flows/segments_added',
  'flows/segments_deleted',
  'sources/created',
  'sources/updated',
  'sources/deleted'
] as const;

export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

const WebhookEvent = Type.Union(
  WEBHOOK_EVENTS.map((event) => Type.Literal(event))
);

// UUID (uuid.json). The filter id lists and the webhook id MUST be UUIDs;
// accepting arbitrary strings let invalid ids (e.g. "") be stored and echoed
// back, violating the spec's uuid pattern on read.
const Uuid = Type.String({
  pattern:
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
});

// Full lifecycle status (webhook-get.json).
const WebhookStatus = Type.Union([
  Type.Literal('created'),
  Type.Literal('started'),
  Type.Literal('disabled'),
  Type.Literal('error')
]);

// Client-settable status (webhook-post.json / webhook-put.json): only these two.
const WebhookInputStatus = Type.Union([
  Type.Literal('created'),
  Type.Literal('disabled')
]);

// Error detail (TAMS error.json subset), set when status is `error`.
const WebhookError = Type.Object({
  type: Type.String(),
  summary: Type.String(),
  time: Type.String()
});

// Common registration fields (webhook.json). The filter and get_urls options are
// stored verbatim; phase 1 applies flow_ids / source_ids filtering on delivery
// (see notifyWebhooks). The remaining get_urls filters are accepted and stored
// for forward compatibility.
const WebhookBase = Type.Object({
  url: Type.String(),
  api_key_name: Type.Optional(Type.String()),
  events: Type.Array(WebhookEvent),
  flow_ids: Type.Optional(Type.Array(Uuid)),
  source_ids: Type.Optional(Type.Array(Uuid)),
  flow_collected_by_ids: Type.Optional(Type.Array(Uuid)),
  source_collected_by_ids: Type.Optional(Type.Array(Uuid)),
  // accept_get_urls are URL labels, not UUIDs.
  accept_get_urls: Type.Optional(Type.Array(Type.String())),
  accept_storage_ids: Type.Optional(Type.Array(Uuid)),
  presigned: Type.Optional(Type.Boolean()),
  verbose_storage: Type.Optional(Type.Boolean()),
  tags: Type.Optional(Type.Record(Type.String(), Type.String()))
});

// POST body (webhook-post.json): base + the secret + an optional initial status.
export const WebhookPost = Type.Intersect([
  WebhookBase,
  Type.Object({
    api_key_value: Type.Optional(Type.String()),
    status: Type.Optional(WebhookInputStatus)
  })
]);

// PUT body (webhook-put.json): base + id + status + optional secret.
export const WebhookPut = Type.Intersect([
  WebhookBase,
  Type.Object({
    id: Uuid,
    api_key_value: Type.Optional(Type.String()),
    status: WebhookInputStatus
  })
]);

// GET representation (webhook-get.json): base + id + status + optional error.
// NEVER carries api_key_value.
export const WebhookGet = Type.Intersect([
  WebhookBase,
  Type.Object({
    id: Uuid,
    status: WebhookStatus,
    error: Type.Optional(WebhookError)
  })
]);

// Stored document: GET representation plus the secret and CouchDB bookkeeping.
export const Webhook = Type.Intersect([
  WebhookGet,
  Type.Object({ api_key_value: Type.Optional(Type.String()) })
]);
export const DBWebhook = Type.Intersect([Webhook, DBProperties]);

export type WebhookDoc = Static<typeof DBWebhook>;

// Project a stored webhook to its GET representation: drop CouchDB bookkeeping
// and, critically, the api_key_value secret which MUST never be returned.
export const toWebhookGet = (
  doc: Static<typeof DBWebhook>
): Static<typeof WebhookGet> => {
  const copy = { ...doc } as Record<string, unknown>;
  delete copy._id;
  delete copy._rev;
  delete copy.api_key_value;
  return copy as Static<typeof WebhookGet>;
};

export { WebhookEvent, WebhookStatus, WebhookInputStatus };
