import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import { flowsClient } from '../../../DB/client';
import { DBFlow, Flow } from '../../../DB/schemas/Flow';
import Logger from '../../../utils/Logger';

const opts = {
  schema: {
    description: 'Create or update flow',
    body: Flow,
    response: {
      200: Flow
    }
  }
};

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
    Body: Static<typeof Flow>;
    Reply: Static<typeof Flow | typeof putFlowErrorBody>;
    Params: Static<typeof putFlowParams>;
  }>('/flows/:id', opts, async (request, reply) => {
    const { id } = request.params;
    const bodyFlow: Static<typeof Flow> = request.body;

    let flow: Partial<typeof DBFlow> = {};
    try {
      flow = await flowsClient.get(id);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      if (e.statusCode !== 404) {
        Logger.red(JSON.stringify(e));
        throw e;
      }
    }

    const updatedFlow: Static<typeof DBFlow> = {
      ...flow,
      ...bodyFlow,
      _id: id
    };

    await flowsClient.insert(updatedFlow);

    reply.code(200).send(updatedFlow);
  });
  next();
};

export default putFlow;
