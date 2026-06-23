import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import { webhooksClient } from '../../../db/client';
import { toWebhookGet } from '../../../db/schemas/webhooks/Webhook';
import getOrUndefined from '../../../db/getOrUndefined';
import httpError from '../../utils/http-error';

const opts = {
  schema: {
    tags: ['Webhooks'],
    description: 'Get the details of a registered webhook'
  }
};

const GetWebhookParams = Type.Object({
  webhookId: Type.String()
});

const getWebhook: FastifyPluginCallback = (fastify, _, next) => {
  fastify.get<{ Params: Static<typeof GetWebhookParams> }>(
    '/service/webhooks/:webhookId',
    opts,
    async (request, reply) => {
      const { webhookId } = request.params;
      const doc = await getOrUndefined(webhooksClient, webhookId);
      if (!doc) {
        throw httpError(404, `Webhook "${webhookId}" not found`);
      }
      reply.code(200).send(toWebhookGet(doc));
    }
  );
  next();
};

export default getWebhook;
