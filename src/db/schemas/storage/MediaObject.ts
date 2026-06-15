import { Type } from '@sinclair/typebox';
import { MediaObjectPutUrl } from './PutUrl';

const MediaObject = Type.Object({
  object_id: Type.String(),
  put_url: MediaObjectPutUrl
});

export default MediaObject;
