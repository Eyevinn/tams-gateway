import { Type } from '@sinclair/typebox';

const AudioTrack = Type.Object({
  channel_numbers: Type.Optional(Type.Array(Type.Integer())),
  channel_range: Type.Optional(Type.String())
});

export default AudioTrack;
