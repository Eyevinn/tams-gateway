import { Type } from '@sinclair/typebox';
import CollectionItem from '../common/CollectionItem';
import DBProperties from '../common/DBProperties';

const Source = Type.Object({
  id: Type.String(),
  format: Type.String(),
  label: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  created_by: Type.Optional(Type.String()),
  updated_by: Type.Optional(Type.String()),
  created: Type.Optional(Type.String()),
  updated: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Record(Type.String(), Type.String())),
  source_collection: Type.Optional(Type.Array(CollectionItem)),
  // Array of Source ids per source.json (collected_by lists the Sources that
  // collect this one). It is read-only / server-managed; the String typing
  // mismatched the spec and the matching Flow.collected_by array.
  collected_by: Type.Optional(Type.Array(Type.String()))
});

const DBSource = Type.Intersect([Source, DBProperties]);

export { Source, DBSource };
