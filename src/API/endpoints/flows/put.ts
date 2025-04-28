import { Static, Type } from '@sinclair/typebox';
import { FastifyError, FastifyPluginCallback } from 'fastify';
import Logger from '../../../utils/Logger';
import { flowsClient } from '../../../DB/client';

const opts = {
  schema: {
    description: 'Create or update flow',
    body: {
      type: 'object',
      required: ['id', 'source_id'],
      properties: {
        id: { type: 'string' },
        source_id: { type: 'string' }
      }
    },
    response: {
      200: {
        description: 'Successful response',
        type: 'object',
        properties: {
          id: { type: 'string' },
          source_id: { type: 'string' }
        }
      }
    }
  }
};

const putFlowBodyReq = Type.Object({
  id: Type.String(),
  source_id: Type.String()
});

const putFlowBodyReply = Type.Object({
  id: Type.String(),
  source_id: Type.String()
});

const putFlowErrorBody = Type.Object({
  code: Type.Number(),
  message: Type.String(),
  id: Type.String()
});

const putFlowParams = Type.Object({
  id: Type.String()
});

const putFlow: FastifyPluginCallback = (fastify, _, next) => {
  fastify.put<{
    Body: Static<typeof putFlowBodyReq>;
    Reply: Static<typeof putFlowBodyReply | typeof putFlowErrorBody>;
    Params: Static<typeof putFlowParams>;
  }>('/flows/:id', opts, async (request, reply) => {
    const { id } = request.params;
    const { source_id } = request.body;

    let flow = {};
    try {
      flow = await flowsClient.get(id);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      if (e.statusCode !== 404) {
        throw e;
      }
    }

    const updatedFlow = {
      ...flow,
      _id: id,
      id,
      source_id
    };

    await flowsClient.insert(updatedFlow);

    reply.code(200).send({ id, source_id });
  });
  next();
};

export default putFlow;
