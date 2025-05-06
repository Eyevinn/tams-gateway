import { Type } from '@sinclair/typebox';
import Segment from './Segment';
import DBProperties from '../common/DBProperties';

const Segments = Type.Object({
  segments: Type.Array(Segment)
});

const DBSegments = Type.Intersect([Segments, DBProperties]);

export { Segments, DBSegments };
