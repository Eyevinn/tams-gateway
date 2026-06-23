import { Static } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { webhooksClient } from '../../../db/client';
import {
  WebhookPost,
  DBWebhook,
  toWebhookGet
} from '../../../db/schemas/webhooks/Webhook';

const opts = {
  schema: {
    tags: ['Webhooks'],
    description: 'Register a webhook to receive event notifications',
    body: WebhookPost
    // No response schema: the webhook is returned via toWebhookGet (which drops
    // the api_key_value secret) so the body stays valid against webhook-get.json
    // without an allOf response serializer dropping spec fields.
  }
};

const postWebhook: FastifyPluginCallback = (fastify, _, next) => {
  fastify.post<{ Body: Static<typeof WebhookPost> }>(
    '/service/webhooks',
    opts,
    async (request, reply) => {
      const id = uuidv4();
      // Client may register disabled; otherwise we register active (started),
      // since this gateway dispatches events synchronously.
      const status =
        request.body.status === 'disabled' ? 'disabled' : 'started';
      const doc: Static<typeof DBWebhook> = {
        ...request.body,
        id,
        _id: id,
        status
      };
      await webhooksClient.insert(doc);
      reply.code(201).send(toWebhookGet(doc));
    }
  );
  next();
};

export default postWebhook;
