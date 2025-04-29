import { Type } from '@sinclair/typebox';
import AspectRatio from './AscpectRatio';
import AvcParameters from './AvcParameters';
import FrameRate from './FrameRate';
import UncParameters from './UncParameters';

const EssenceParameters = Type.Object({
  frame_rate: Type.Optional(FrameRate),
  frame_width: Type.Integer(),
  frame_height: Type.Integer(),
  bit_depth: Type.Optional(Type.Integer()),
  interlace_mode: Type.Optional(Type.String()),
  colorspace: Type.Optional(Type.String()),
  transfer_characteristics: Type.Optional(Type.String()),
  aspect_ratio: Type.Optional(AspectRatio),
  pixel_aspect_ratio: Type.Optional(AspectRatio),
  component_type: Type.Optional(Type.String()),
  horiz_chroma_subs: Type.Optional(Type.Integer()),
  vert_chroma_subs: Type.Optional(Type.Integer()),
  unc_parameters: Type.Optional(UncParameters),
  avc_parameters: Type.Optional(AvcParameters)
});

export default EssenceParameters;
