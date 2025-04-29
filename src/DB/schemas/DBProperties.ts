import { Type } from '@sinclair/typebox';

const DBProperties = Type.Object({
  _id: Type.String(),
  _rev: Type.Optional(Type.String())
});

export default DBProperties;
