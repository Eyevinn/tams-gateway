import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import { flowsClient, sourcesClient } from '../../../db/client';
import { DBFlow, Flow } from '../../../db/schemas/flows/Flow';
import ErrorResponse from '../../utils/error-response';
import { DBSource } from '../../../db/schemas/sources/Source';

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

    // Segments are stored as individual documents created via
    // POST /flows/:id/segments, so nothing to pre-create here.
    reply.code(200).send(updatedFlow);
  });
  next();
};

export default putFlow;
