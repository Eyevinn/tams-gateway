import { Type } from '@sinclair/typebox';
import Segment from './Segment';
import DBProperties from '../common/DBProperties';

// One CouchDB document per segment. flow_id groups a flow's segments and the
// sortable ts_start/ts_end keys back the Mango index used for timerange queries.
const DBSegment = Type.Intersect([
  Segment,
  DBProperties,
  Type.Object({
    flow_id: Type.String(),
    ts_start: Type.String(),
    ts_end: Type.String()
  })
]);

export { DBSegment };
