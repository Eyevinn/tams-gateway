import { Type } from '@sinclair/typebox';

const MediaObjectPutUrl = Type.Object({
  url: Type.String(),
  'content-type': Type.String()
});

export { MediaObjectPutUrl };
