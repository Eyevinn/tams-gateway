import { Type } from '@sinclair/typebox';

const MxfContainer = Type.Object({
  package_uid: Type.Optional(Type.String()),
  track_id: Type.Optional(Type.String())
});

export default MxfContainer;
