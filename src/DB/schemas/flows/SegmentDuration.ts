import { Type } from '@sinclair/typebox';

const SegmentDuration = Type.Object({
  numerator: Type.Integer(),
  denominator: Type.Integer()
});

export default SegmentDuration;
