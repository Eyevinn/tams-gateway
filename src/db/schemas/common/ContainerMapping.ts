import { Type } from '@sinclair/typebox';
import AudioTrack from '../flows/AudioTrack';
import IsobmffContainer from '../flows/Isobmff_container';
import Mp2tsContainer from '../flows/Mp2tsContainer';
import MxfContainer from '../flows/MxfContainer';

const ContainerMapping = Type.Object({
  track_index: Type.Optional(Type.String()),
  format_track_index: Type.Optional(Type.String()),
  audio_track: Type.Optional(AudioTrack),
  mp2ts_container: Type.Optional(Mp2tsContainer),
  mxf_container: Type.Optional(MxfContainer),
  isobmmf_container: Type.Optional(IsobmffContainer)
});

export default ContainerMapping;
