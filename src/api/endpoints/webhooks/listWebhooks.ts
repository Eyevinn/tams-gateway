import { FastifyPluginCallback } from 'fastify';
import { webhooksClient } from '../../../db/client';
import { toWebhookGet } from '../../../db/schemas/webhooks/Webhook';

const opts = {
  schema: {
    tags: ['Webhooks'],
    description: 'List registered webhooks'
    // No response schema: webhooks are projected with toWebhookGet so the
    // api_key_value secret is never returned (see postWebhook).
  }
};

const listWebhooks: FastifyPluginCallback = (fastify, _, next) => {
  fastify.get('/service/webhooks', opts, async (_request, reply) => {
    const result = await webhooksClient.list({ include_docs: true });
    const webhooks = result.rows
      .map((row) => row.doc)
      .filter((doc) => !!doc)
      .map((doc) => toWebhookGet(doc!));
    reply.code(200).send(webhooks);
  });
  next();
};

export default listWebhooks;
