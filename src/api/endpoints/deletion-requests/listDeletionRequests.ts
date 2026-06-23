import { FastifyPluginCallback } from 'fastify';
import { deletionRequestsClient } from '../../../db/client';
import stripDbFields from '../../../db/stripDbFields';

const opts = {
  schema: {
    tags: ['Flow Delete Requests'],
    description: 'List flow delete requests'
  }
};

const listDeletionRequests: FastifyPluginCallback = (fastify, _, next) => {
  fastify.get('/flow-delete-requests', opts, async (_request, reply) => {
    const result = await deletionRequestsClient.list({ include_docs: true });
    const requests = result.rows
      .map((row) => row.doc)
      .filter((doc) => !!doc)
      .map((doc) => stripDbFields(doc!));
    reply.code(200).send(requests);
  });
  next();
};

export default listDeletionRequests;
