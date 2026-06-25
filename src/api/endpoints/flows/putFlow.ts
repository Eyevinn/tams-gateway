import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import { flowsClient, sourcesClient } from '../../../db/client';
import { DBFlow, Flow } from '../../../db/schemas/flows/Flow';
import { DBSource } from '../../../db/schemas/sources/Source';
import CollectionItem from '../../../db/schemas/common/CollectionItem';
import httpError from '../../utils/http-error';
import getOrUndefined from '../../../db/getOrUndefined';
import stripDbFields from '../../../db/stripDbFields';
import notifyWebhooks from '../../utils/notifyWebhooks';

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
    const sourceExists = existingSource !== undefined;

    // Derive the Source's source_collection from the Flow's flow_collection.
    // Per TAMS source.json + app note 0001, source_collection is server-managed
    // and inferred from the Flow collection: each member Flow contributes its
    // own Source (resolved via the member Flow's source_id), carrying the role.
    // Members not yet registered are skipped, so the collection completes as
    // members are created. The grouping Flow is inserted above, so a member that
    // points back at this Flow's own Source resolves correctly.
    let sourceCollection: Static<typeof CollectionItem>[] | undefined;
    if (bodyFlow.flow_collection && bodyFlow.flow_collection.length > 0) {
      const resolved = await Promise.all(
        bodyFlow.flow_collection.map(async (member) => {
          const memberFlow = await getOrUndefined(flowsClient, member.id);
          if (!memberFlow?.source_id) {
            return undefined;
          }
          return { id: memberFlow.source_id, role: member.role };
        })
      );
      sourceCollection = resolved.filter(
        (item): item is Static<typeof CollectionItem> => item !== undefined
      );
    }

    const updatedSource: Static<typeof DBSource> = {
      // Spreading the existing document preserves client-managed Source fields
      // (label/description/tags set via the /sources/:id/* endpoints) and any
      // previously derived source_collection: a flow PUT updates the Source's
      // format and refreshes its derived collection without clobbering the rest.
      ...existingSource,
      id: bodyFlow.source_id,
      _id: bodyFlow.source_id,
      format: bodyFlow.format,
      ...(sourceCollection ? { source_collection: sourceCollection } : {})
    };
    // Create or update source
    await sourcesClient.insert(updatedSource);

    // Emit flow + source event notifications (never throws).
    await notifyWebhooks(
      exists ? 'flows/updated' : 'flows/created',
      { flow: stripDbFields(updatedFlow) },
      { flowId: id, sourceId: bodyFlow.source_id }
    );
    await notifyWebhooks(
      sourceExists ? 'sources/updated' : 'sources/created',
      { source: stripDbFields(updatedSource) },
      { sourceId: bodyFlow.source_id }
    );

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
