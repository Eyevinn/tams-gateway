import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import { flowsClient } from '../../../DB/client';
import { Flow } from '../../../DB/schemas/Flow';
import ErrorResponse from '../../utils/error-response';

const Flows = Type.Array(Flow);

const opts = {
  schema: {
    description: 'List flows',
    response: {
      200: Flows
    }
  }
};

const listFlows: FastifyPluginCallback = (fastify, _, next) => {
  fastify.get<{
    Reply: Static<typeof Flows | typeof ErrorResponse>;
  }>('/flows', opts, async (_, reply) => {
    const DBFlows = await flowsClient.list({ include_docs: true });
    const flows: Static<typeof Flows> = DBFlows.rows
      .map((DBFlow) => {
        return DBFlow.doc;
      })
      .filter((flow) => !!flow);

    reply.code(200).send(flows);
  });
  next();
};

export default listFlows;
