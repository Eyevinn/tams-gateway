import { Static, Type, TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { FastifyPluginCallback } from 'fastify';
import { DocumentScope } from 'nano';
import getOrUndefined from '../../../db/getOrUndefined';
import httpError from '../../utils/http-error';

// A document with the bookkeeping, read_only and tags fields the property and
// tag handlers need; the dynamic index covers the property being read/written.
export interface ResourceDoc {
  _id: string;
  _rev?: string;
  read_only?: boolean;
  tags?: Record<string, string>;
  [key: string]: unknown;
}

// Loosely-typed client shared by the property and tag endpoint factories. The
// concrete flowsClient / sourcesClient are cast to this at the call site.
export type PropertyClient = DocumentScope<ResourceDoc>;

export interface PropertyOptions {
  client: PropertyClient;
  // Route prefix carrying the :id param, e.g. '/flows/:id' or '/sources/:id'.
  basePath: string;
  // Human label for error messages, e.g. 'Flow' or 'Source'.
  resourceName: string;
  // Swagger tag.
  tag: string;
  // The document field this endpoint group reads and writes.
  field: string;
  // TypeBox schema the PUT body is validated against.
  valueSchema: TSchema;
  // read_only has no DELETE; most properties do.
  allowDelete?: boolean;
  // Whether a read_only resource rejects writes (the read_only endpoint itself
  // must NOT be guarded, otherwise the resource could never be unlocked).
  guardReadOnly?: boolean;
}

// Generic GET/PUT/DELETE for a single scalar/array property of a resource
// (TAMS /flows/{id}/<prop> and /sources/{id}/<prop>). Reused for description,
// label, read_only, bit rates and flow_collection.
export const propertyEndpoints = (
  options: PropertyOptions
): FastifyPluginCallback => {
  const {
    client,
    basePath,
    resourceName,
    tag,
    field,
    valueSchema,
    allowDelete = true,
    guardReadOnly = true
  } = options;
  const Params = Type.Object({ id: Type.String() });
  const path = `${basePath}/${field}`;
  const notFound = (id: string) =>
    httpError(404, `${resourceName} "${id}" not found`);

  return (fastify, _, next) => {
    fastify.get<{ Params: Static<typeof Params> }>(
      path,
      {
        schema: { tags: [tag], description: `Get the ${resourceName} ${field}` }
      },
      async (request, reply) => {
        const doc = await getOrUndefined(client, request.params.id);
        if (!doc) throw notFound(request.params.id);
        // A scalar property value is JSON (a quoted string / bare number /
        // boolean), so serialise it explicitly: a bare reply.send(string) would
        // go out as text/plain.
        reply
          .header('content-type', 'application/json')
          .code(200)
          .send(JSON.stringify(doc[field] ?? null));
      }
    );

    fastify.put<{ Params: Static<typeof Params>; Body: unknown }>(
      path,
      {
        schema: {
          tags: [tag],
          description: `Create or update the ${resourceName} ${field}`,
          body: valueSchema
        }
      },
      async (request, reply) => {
        // Fastify does not validate a primitive top-level body against the
        // schema, so check it explicitly (else a number could be stored as a
        // string property and break the GET response schema).
        if (!Value.Check(valueSchema, request.body)) {
          throw httpError(400, `Invalid value for ${resourceName} ${field}`);
        }
        const doc = await getOrUndefined(client, request.params.id);
        if (!doc) throw notFound(request.params.id);
        if (guardReadOnly && doc.read_only) {
          throw httpError(
            403,
            `${resourceName} "${request.params.id}" is read-only`
          );
        }
        doc[field] = request.body;
        await client.insert(doc);
        reply.code(204).send(undefined);
      }
    );

    if (allowDelete) {
      fastify.delete<{ Params: Static<typeof Params> }>(
        path,
        {
          schema: {
            tags: [tag],
            description: `Delete the ${resourceName} ${field}`
          }
        },
        async (request, reply) => {
          const doc = await getOrUndefined(client, request.params.id);
          if (!doc) throw notFound(request.params.id);
          if (guardReadOnly && doc.read_only) {
            throw httpError(
              403,
              `${resourceName} "${request.params.id}" is read-only`
            );
          }
          delete doc[field];
          await client.insert(doc);
          reply.code(204).send(undefined);
        }
      );
    }

    next();
  };
};

export default propertyEndpoints;
