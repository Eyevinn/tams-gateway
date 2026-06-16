import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import { flowsClient, sourcesClient } from '../../../db/client';
import { DBFlow, Flow } from '../../../db/schemas/flows/Flow';
import { DBSource } from '../../../db/schemas/sources/Source';
import httpError from '../../utils/http-error';
import getOrUndefined from '../../../db/getOrUndefined';
import stripDbFields from '../../../db/stripDbFields';

const opts = {
  schema: {
    tags: ['Flows'],
    description: 'Create or update flow',
    body: Flow
    // No response schema: the created Flow is returned verbatim (minus _id/_rev)
    // so it validates against flow.json. A narrow schema would drop
    // format-specific essence_parameters (e.g. audio sample_rate/channels).
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
    // collected_by is read-only / server-managed per the TAMS spec
    // (flow-core.json: "Service implementations SHOULD ignore this if given in
    // a PUT request"). Ignore any client-supplied value so the stored and
    // returned Flow stays valid against flow.json.
    const bodyFlow: Static<typeof Flow> = { ...request.body };
    delete bodyFlow.collected_by;

    // A Source is created/updated from source_id; an empty value would produce
    // an invalid document id, so reject it as a client error rather than 500.
    if (!bodyFlow.source_id) {
      throw httpError(400, 'source_id must not be empty');
    }

    const existingFlow = await getOrUndefined(flowsClient, id);
    const exists = existingFlow !== undefined;

    const updatedFlow: Static<typeof DBFlow> = {
      ...existingFlow,
      ...bodyFlow,
      _id: id
    };

    // Create or update flow
    await flowsClient.insert(updatedFlow);

    const existingSource = await getOrUndefined(
      sourcesClient,
      bodyFlow.source_id
    );
    const updatedSource: Static<typeof DBSource> = {
      ...existingSource,
      id: bodyFlow.source_id,
      _id: bodyFlow.source_id,
      format: bodyFlow.format
    };
    // Create or update source
    await sourcesClient.insert(updatedSource);

    // Segments are stored as individual documents created via
    // POST /flows/:id/segments, so nothing to pre-create here.
    //
    // Per the TAMS spec: 201 with the Flow body on create, 204 with no body on
    // update.
    if (exists) {
      reply.code(204).send(undefined);
    } else {
      reply.code(201).send(stripDbFields(updatedFlow));
    }
  });
  next();
};

export default putFlow;
