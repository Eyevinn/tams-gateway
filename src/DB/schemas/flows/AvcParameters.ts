import { Type } from '@sinclair/typebox';

const AvcParameters = Type.Object({
  profile: Type.Integer(),
  level: Type.Integer(),
  flags: Type.Integer()
});

export default AvcParameters;
