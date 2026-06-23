import { Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { FastifyPluginCallback } from 'fastify';
import getOrUndefined from '../../../db/getOrUndefined';
import httpError from '../../utils/http-error';
import { PropertyClient } from './propertyEndpoints';

export interface TagsOptions {
  client: PropertyClient;
  // Route prefix carrying the :id param, e.g. '/flows/:id' or '/sources/:id'.
  basePath: string;
  resourceName: string;
  tag: string;
  guardReadOnly?: boolean;
}

// Generic tag endpoints: the read-only collection (GET /<resource>/{id}/tags)
// plus per-name GET/PUT/DELETE (/<resource>/{id}/tags/{name}), per the TAMS spec.
export const tagsEndpoints = (options: TagsOptions): FastifyPluginCallback => {
  const { client, basePath, resourceName, tag, guardReadOnly = true } = options;
  const IdParams = Type.Object({ id: Type.String() });
  const NameParams = Type.Object({ id: Type.String(), name: Type.String() });
  const collectionPath = `${basePath}/tags`;
  const namePath = `${basePath}/tags/:name`;
  const notFound = (id: string) =>
    httpError(404, `${resourceName} "${id}" not found`);

  return (fastify, _, next) => {
    fastify.get<{ Params: Static<typeof IdParams> }>(
      collectionPath,
      { schema: { tags: [tag], description: `Get the ${resourceName} tags` } },
      async (request, reply) => {
        const doc = await getOrUndefined(client, request.params.id);
        if (!doc) throw notFound(request.params.id);
        reply.code(200).send(doc.tags ?? {});
      }
    );

    fastify.get<{ Params: Static<typeof NameParams> }>(
      namePath,
      {
        schema: { tags: [tag], description: `Get a ${resourceName} tag value` }
      },
      async (request, reply) => {
        const { id, name } = request.params;
        const doc = await getOrUndefined(client, id);
        if (!doc) throw notFound(id);
        const value = doc.tags?.[name];
        if (value === undefined) {
          throw httpError(404, `Tag "${name}" not found`);
        }
        // Send the tag value as a JSON string, not text/plain.
        reply
          .header('content-type', 'application/json')
          .code(200)
          .send(JSON.stringify(value));
      }
    );

    fastify.put<{ Params: Static<typeof NameParams>; Body: string }>(
      namePath,
      {
        schema: {
          tags: [tag],
          description: `Create or update a ${resourceName} tag`,
          body: Type.String()
        }
      },
      async (request, reply) => {
        const { id, name } = request.params;
        // A tag value must be a string; Fastify does not validate a primitive
        // body, so check explicitly.
        if (!Value.Check(Type.String(), request.body)) {
          throw httpError(400, 'Tag value must be a string');
        }
        const doc = await getOrUndefined(client, id);
        if (!doc) throw notFound(id);
        if (guardReadOnly && doc.read_only) {
          throw httpError(403, `${resourceName} "${id}" is read-only`);
        }
        doc.tags = { ...doc.tags, [name]: request.body };
        await client.insert(doc);
        reply.code(204).send(undefined);
      }
    );

    fastify.delete<{ Params: Static<typeof NameParams> }>(
      namePath,
      { schema: { tags: [tag], description: `Delete a ${resourceName} tag` } },
      async (request, reply) => {
        const { id, name } = request.params;
        const doc = await getOrUndefined(client, id);
        if (!doc) throw notFound(id);
        if (guardReadOnly && doc.read_only) {
          throw httpError(403, `${resourceName} "${id}" is read-only`);
        }
        if (doc.tags) {
          delete doc.tags[name];
          await client.insert(doc);
        }
        reply.code(204).send(undefined);
      }
    );

    next();
  };
};

export default tagsEndpoints;
