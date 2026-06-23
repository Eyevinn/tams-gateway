import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import { webhooksClient } from '../../../db/client';
import {
  WebhookPut,
  DBWebhook,
  toWebhookGet
} from '../../../db/schemas/webhooks/Webhook';
import getOrUndefined from '../../../db/getOrUndefined';
import httpError from '../../utils/http-error';

const opts = {
  schema: {
    tags: ['Webhooks'],
    description: 'Update an existing webhook',
    body: WebhookPut
  }
};

const PutWebhookParams = Type.Object({
  webhookId: Type.String()
});

const putWebhook: FastifyPluginCallback = (fastify, _, next) => {
  fastify.put<{
    Body: Static<typeof WebhookPut>;
    Params: Static<typeof PutWebhookParams>;
  }>('/service/webhooks/:webhookId', opts, async (request, reply) => {
    const { webhookId } = request.params;
    const existing = await getOrUndefined(webhooksClient, webhookId);
    if (!existing) {
      throw httpError(404, `Webhook "${webhookId}" not found`);
    }

    // The spec forbids transitioning an `error` status directly to `disabled`
    // (webhook-get.json status doc): a client re-enables via `created` first.
    if (existing.status === 'error' && request.body.status === 'disabled') {
      throw httpError(
        400,
        'Cannot disable a webhook in the error state; re-enable it (status=created) first'
      );
    }

    const status = request.body.status === 'disabled' ? 'disabled' : 'started';
    const doc: Static<typeof DBWebhook> = {
      ...request.body,
      // Path id is authoritative; keep the stored revision so this is an update.
      id: webhookId,
      _id: webhookId,
      _rev: existing._rev,
      // Preserve the stored secret when the update omits it.
      api_key_value: request.body.api_key_value ?? existing.api_key_value,
      status
    };
    await webhooksClient.insert(doc);
    reply.code(201).send(toWebhookGet(doc));
  });
  next();
};

export default putWebhook;
