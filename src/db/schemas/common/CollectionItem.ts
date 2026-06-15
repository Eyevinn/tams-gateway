import { Type } from '@sinclair/typebox';
import ContainerMapping from './ContainerMapping';

const CollectionItem = Type.Object({
  id: Type.String(),
  role: Type.String(),
  container_mapping: ContainerMapping
});

export default CollectionItem;
