import { Type } from '@sinclair/typebox';

const IsobmffContainer = Type.Object({
  track_id: Type.Optional(Type.Integer())
});

export default IsobmffContainer;
