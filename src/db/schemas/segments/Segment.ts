import { Type } from '@sinclair/typebox';
import GetUrl from '../storage/GetUrl';

const Segment = Type.Object({
  object_id: Type.String(),
  // TAMS timerange "[<sec>:<ns>_<sec>:<ns>)" (TAI). Bounds are required for a segment.
  timerange: Type.String({
    pattern: '^[[(]?\\d+:\\d+_\\d+:\\d+[\\])]?$'
  }),
  get_urls: Type.Optional(Type.Array(GetUrl)),
  sample_count: Type.Optional(Type.Integer()),
  sample_offset: Type.Optional(Type.Integer())
});

export default Segment;
