import { Type } from '@sinclair/typebox';

const Mp2tsContainer = Type.Object({
  pid: Type.Optional(Type.Integer())
});

export default Mp2tsContainer;
