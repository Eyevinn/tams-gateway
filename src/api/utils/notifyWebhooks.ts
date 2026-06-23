// Webhook event delivery (TAMS event notifications).
//
// notifyWebhooks finds the registered webhooks subscribed to an event, applies
// the flow_ids / source_ids delivery filters, and POSTs the spec event body to
// each. It NEVER throws: a webhook delivery failure must never fail the API
// request that triggered the event, so every error is caught and logged. The
// mutation handlers (putFlow, deleteFlow, postSegments) await it for
// deterministic ordering, knowing it cannot reject.

import { webhooksClient } from '../../db/client';
import Logger from '../../utils/Logger';
import {
  WebhookDoc,
  WebhookEventName
} from '../../db/schemas/webhooks/Webhook';
import { DEFAULT_WEBHOOK_TIMEOUT_MS } from '../../config';

const timeoutMs = (): number =>
  process.env.WEBHOOK_TIMEOUT_MS
    ? Number(process.env.WEBHOOK_TIMEOUT_MS)
    : DEFAULT_WEBHOOK_TIMEOUT_MS;

// Basic SSRF guard (phase 1): refuse non-http(s) URLs and the cloud metadata
// address. A fuller egress allowlist is a follow-up (see the gap analysis).
const BLOCKED_HOSTS = new Set(['169.254.169.254']);

const isUrlSafe = (raw: string): boolean => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (BLOCKED_HOSTS.has(url.hostname)) return false;
  return true;
};

// Context carries the ids an event relates to, so per-webhook delivery filters
// (flow_ids, source_ids) can be applied. A filter only constrains events that
// actually carry the matching id: a source event (no flowId) is not filtered by
// flow_ids, and vice versa.
export interface EventContext {
  flowId?: string;
  sourceId?: string;
}

const matchesFilters = (
  webhook: WebhookDoc,
  context: EventContext
): boolean => {
  if (
    webhook.flow_ids?.length &&
    context.flowId &&
    !webhook.flow_ids.includes(context.flowId)
  ) {
    return false;
  }
  if (
    webhook.source_ids?.length &&
    context.sourceId &&
    !webhook.source_ids.includes(context.sourceId)
  ) {
    return false;
  }
  return true;
};

const deliver = async (webhook: WebhookDoc, body: string): Promise<void> => {
  if (!isUrlSafe(webhook.url)) {
    Logger.red(
      `Webhook ${webhook.id}: refusing delivery to unsafe URL ${webhook.url}`
    );
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (webhook.api_key_name && webhook.api_key_value) {
      headers[webhook.api_key_name] = webhook.api_key_value;
    }
    const res = await fetch(webhook.url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal
    });
    if (!res.ok) {
      Logger.red(
        `Webhook ${webhook.id}: ${webhook.url} returned ${res.status}`
      );
    }
  } catch (err) {
    Logger.red(
      `Webhook ${webhook.id}: delivery to ${webhook.url} failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  } finally {
    clearTimeout(timer);
  }
};

// Deliver `event` to every active webhook subscribed to `eventType` that passes
// its delivery filters. Never throws.
export async function notifyWebhooks(
  eventType: WebhookEventName,
  event: Record<string, unknown>,
  context: EventContext = {}
): Promise<void> {
  try {
    // Active webhooks only: created (registered, eligible to send) or started.
    const result = await webhooksClient.find({
      selector: { status: { $in: ['created', 'started'] } },
      limit: 1000
    });
    const matched = result.docs.filter(
      (webhook) =>
        webhook.events.includes(eventType) && matchesFilters(webhook, context)
    );
    if (matched.length === 0) return;

    const body = JSON.stringify({
      event_timestamp: new Date().toISOString(),
      event_type: eventType,
      event
    });
    await Promise.allSettled(matched.map((webhook) => deliver(webhook, body)));
  } catch (err) {
    // A failure to even query/dispatch must not break the triggering request.
    Logger.red(
      `Webhook notification for ${eventType} failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

export default notifyWebhooks;
