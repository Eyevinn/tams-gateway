import { Type } from '@sinclair/typebox';
import AudioTrack from '../flows/AudioTrack';
import IsobmffContainer from '../flows/Isobmff_container';
import Mp2tsContainer from '../flows/Mp2tsContainer';
import MxfContainer from '../flows/MxfContainer';

const ContainerMapping = Type.Object({
  // Integers per container-mapping.json (zero-based track indices). Declaring
  // them as String coerced numeric input to a string, so {"track_index": 0}
  // round-tripped as {"track_index": "0"}.
  track_index: Type.Optional(Type.Integer({ minimum: 0 })),
  format_track_index: Type.Optional(Type.Integer({ minimum: 0 })),
  audio_track: Type.Optional(AudioTrack),
  mp2ts_container: Type.Optional(Mp2tsContainer),
  mxf_container: Type.Optional(MxfContainer),
  // Spec key is isobmff_container (ISO Base Media File Format); the previous
  // isobmmf_container misspelling meant the mapping was never validated.
  isobmff_container: Type.Optional(IsobmffContainer)
});

export default ContainerMapping;
