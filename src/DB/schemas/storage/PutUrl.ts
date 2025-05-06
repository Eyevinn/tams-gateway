import { Type } from '@sinclair/typebox';

const BucketPutUrl = Type.Object({
  url: Type.String(),
  body: Type.String()
});

const MediaObjectPutUrl = Type.Object({
  url: Type.String(),
  'content-type': Type.String()
});

export { BucketPutUrl, MediaObjectPutUrl };
