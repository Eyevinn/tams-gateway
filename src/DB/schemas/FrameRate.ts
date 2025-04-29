import { Type } from '@sinclair/typebox';

const FrameRate = Type.Object({
  numerator: Type.Integer(),
  denominator: Type.Optional(Type.Integer())
});

export default FrameRate;
