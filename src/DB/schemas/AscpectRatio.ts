import { Type } from '@sinclair/typebox';

const AspectRatio = Type.Object({
  numerator: Type.Integer(),
  denominator: Type.Integer()
});

export default AspectRatio;
