import { Type } from '@sinclair/typebox';

const MxfContainer = Type.Object({
  package_uid: Type.Optional(Type.String()),
  // Integer per container-mapping.json (mxf_container.track_id); String coerced
  // numeric input to a string on round-trip.
  track_id: Type.Optional(Type.Integer())
});

export default MxfContainer;
