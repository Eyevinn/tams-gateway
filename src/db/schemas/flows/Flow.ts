import { Type } from '@sinclair/typebox';
import CollectionItem from '../common/CollectionItem';
import ContainerMapping from '../common/ContainerMapping';
import EssenceParameters from './EssenceParameters';
import SegmentDuration from './SegmentDuration';
import DBProperties from '../common/DBProperties';

const Flow = Type.Object(
  {
    id: Type.String(),
    source_id: Type.String(),
    label: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    created_by: Type.Optional(Type.String()),
    updated_by: Type.Optional(Type.String()),
    tags: Type.Optional(Type.Record(Type.String(), Type.String())),
    metadata_version: Type.Optional(Type.String()),
    generation: Type.Optional(Type.Integer()),
    created: Type.Optional(Type.String()),
    metadata_updated: Type.Optional(Type.String()),
    segments_updated: Type.Optional(Type.String()),
    read_only: Type.Optional(Type.Boolean()),
    // codec is optional per flow-core.json: a grouping Multi-Flow
    // (urn:x-nmos:format:multi) collects per-essence Flows via flow_collection
    // and has no codec or container of its own. Marking it required rejected
    // spec-valid Multi-Flows with a 400.
    codec: Type.Optional(Type.String()),
    container: Type.Optional(Type.String()),
    avg_bit_rate: Type.Optional(Type.Number()),
    max_bit_rate: Type.Optional(Type.Number()),
    segment_duration: Type.Optional(SegmentDuration),
    timerange: Type.Optional(Type.String()),
    flow_collection: Type.Optional(Type.Array(CollectionItem)),
    collected_by: Type.Optional(Type.Array(Type.String())),
    container_mapping: Type.Optional(ContainerMapping),
    format: Type.String(),
    // essence_parameters is optional for the same reason as codec: a Multi-Flow
    // describes no essence of its own, so flow-multi.json omits it. Only the
    // mono-essence Flow types (video/audio/image/data) require it.
    essence_parameters: Type.Optional(EssenceParameters)
  },
  { additionalProperties: false }
);

const DBFlow = Type.Intersect([Flow, DBProperties]);

export { Flow, DBFlow };
