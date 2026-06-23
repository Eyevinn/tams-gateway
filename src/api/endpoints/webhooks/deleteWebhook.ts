import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import { webhooksClient } from '../../../db/client';
import getOrUndefined from '../../../db/getOrUndefined';
import httpError from '../../utils/http-error';

const opts = {
  schema: {
    tags: ['Webhooks'],
    description: 'Delete a webhook'
  }
};

const DeleteWebhookParams = Type.Object({
  webhookId: Type.String()
});

const deleteWebhook: FastifyPluginCallback = (fastify, _, next) => {
  fastify.delete<{ Params: Static<typeof DeleteWebhookParams> }>(
    '/service/webhooks/:webhookId',
    opts,
    async (request, reply) => {
      const { webhookId } = request.params;
      const existing = await getOrUndefined(webhooksClient, webhookId);
      if (!existing) {
        throw httpError(404, `Webhook "${webhookId}" not found`);
      }
      await webhooksClient.destroy(existing._id, existing._rev!);
      reply.code(204).send(undefined);
    }
  );
  next();
};

export default deleteWebhook;
