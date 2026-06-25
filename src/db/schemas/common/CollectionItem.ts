import { Type } from '@sinclair/typebox';
import ContainerMapping from './ContainerMapping';

const CollectionItem = Type.Object({
  id: Type.String(),
  role: Type.String(),
  // Optional per collection-item.json + flow-collection.json: a Flow Collection
  // item requires only id + role. container_mapping is supplied only when the
  // member essence needs explicit container placement. Marking it required
  // rejected spec-valid collection items with a 400.
  container_mapping: Type.Optional(ContainerMapping)
});

export default CollectionItem;
