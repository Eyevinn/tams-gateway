import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import { flowsClient, sourcesClient } from '../../../db/client';
import { DBFlow, Flow } from '../../../db/schemas/flows/Flow';
import { DBSource } from '../../../db/schemas/sources/Source';
import httpError from '../../utils/http-error';

const opts = {
  schema: {
    tags: ['Flows'],
    description: 'Create or update flow',
    body: Flow,
    response: {
      201: Flow
    }
  }
};

const PutFlowParams = Type.Object({
  id: Type.String()
});

// Create/update flow, create source and segments if they don't exist in DB
const putFlow: FastifyPluginCallback = (fastify, _, next) => {
  fastify.put<{
    Body: Static<typeof Flow>;
    Reply: Static<typeof Flow> | undefined;
    Params: Static<typeof PutFlowParams>;
  }>('/flows/:id', opts, async (request, reply) => {
    const { id } = request.params;
    const bodyFlow: Static<typeof Flow> = request.body;

    // A Source is created/updated from source_id; an empty value would produce
    // an invalid document id, so reject it as a client error rather than 500.
    if (!bodyFlow.source_id) {
      throw httpError(400, 'source_id must not be empty');
    }

    let flow: Partial<typeof DBFlow> = {};
    let exists = true;
    try {
      flow = await flowsClient.get(id);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      if (e.statusCode !== 404) {
        throw e;
      }
      exists = false;
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
    //
    // Per the TAMS spec: 201 with the Flow body on create, 204 with no body on
    // update.
    if (exists) {
      reply.code(204).send(undefined);
    } else {
      reply.code(201).send(updatedFlow);
    }
  });
  next();
};

export default putFlow;
