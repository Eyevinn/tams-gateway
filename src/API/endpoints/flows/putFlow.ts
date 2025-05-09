import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import { flowsClient, segmentsClient, sourcesClient } from '../../../DB/client';
import { DBFlow, Flow } from '../../../DB/schemas/flows/Flow';
import ErrorResponse from '../../utils/error-response';
import { DBSource } from '../../../DB/schemas/sources/Source';

const opts = {
  schema: {
    tags: ['Flows'],
    description: 'Create or update flow',
    body: Flow,
    response: {
      200: Flow
    }
  }
};

const PutFlowErrorBody = Type.Intersect([
  ErrorResponse,
  Type.Object({ id: Type.String() })
]);

const PutFlowParams = Type.Object({
  id: Type.String()
});

// Create/update flow, create source and segments if they don't exist in DB
const putFlow: FastifyPluginCallback = (fastify, _, next) => {
  fastify.put<{
    Body: Static<typeof Flow>;
    Reply: Static<typeof Flow | typeof PutFlowErrorBody>;
    Params: Static<typeof PutFlowParams>;
  }>('/flows/:id', opts, async (request, reply) => {
    const { id } = request.params;
    const bodyFlow: Static<typeof Flow> = request.body;

    let flow: Partial<typeof DBFlow> = {};
    try {
      flow = await flowsClient.get(id);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      if (e.statusCode !== 404) {
        throw e;
      }
    }

    const updatedFlow: Static<typeof DBFlow> = {
      ...flow,
      ...bodyFlow,
      _id: id
    };

    // Create or update flow
    await flowsClient.insert(updatedFlow);

    let source: Partial<typeof DBSource> = {};
    try {
      source = await sourcesClient.get(bodyFlow.source_id);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      if (e.statusCode !== 404) {
        throw e;
      }
    }
    const updatedSource: Static<typeof DBSource> = {
      ...source,
      id: bodyFlow.source_id,
      _id: bodyFlow.source_id,
      format: bodyFlow.format
    };
    // Create of update source
    await sourcesClient.insert(updatedSource);

    try {
      await segmentsClient.get(bodyFlow.id);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      if (e.statusCode !== 404) {
        throw e;
      }
      // Create segments
      segmentsClient.insert({
        _id: bodyFlow.id,
        segments: []
      });
    }
    reply.code(200).send(updatedFlow);
  });
  next();
};

export default putFlow;
