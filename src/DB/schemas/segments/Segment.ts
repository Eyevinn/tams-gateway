import { Type } from '@sinclair/typebox';
import GetUrl from '../storage/GetUrl';

const Segment = Type.Object({
  object_id: Type.String(),
  timerange: Type.String(),
  get_urls: Type.Optional(Type.Array(GetUrl)),
  sample_count: Type.Optional(Type.Integer()),
  sample_offset: Type.Optional(Type.Integer())
});

export default Segment;
