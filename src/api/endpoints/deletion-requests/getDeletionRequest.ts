import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import { deletionRequestsClient } from '../../../db/client';
import { stripDeletionRequest } from '../../../db/schemas/deletion-requests/DeletionRequest';
import getOrUndefined from '../../../db/getOrUndefined';
import httpError from '../../utils/http-error';

const opts = {
  schema: {
    tags: ['Flow Delete Requests'],
    description: 'Get a flow delete request'
  }
};

const GetDeletionRequestParams = Type.Object({
  requestId: Type.String()
});

const getDeletionRequest: FastifyPluginCallback = (fastify, _, next) => {
  fastify.get<{ Params: Static<typeof GetDeletionRequestParams> }>(
    '/flow-delete-requests/:requestId',
    opts,
    async (request, reply) => {
      const { requestId } = request.params;
      const doc = await getOrUndefined(deletionRequestsClient, requestId);
      if (!doc) {
        throw httpError(404, `Flow delete request "${requestId}" not found`);
      }
      reply.code(200).send(stripDeletionRequest(doc));
    }
  );
  next();
};

export default getDeletionRequest;
