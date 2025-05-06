import { Type } from '@sinclair/typebox';
import { BucketPutUrl } from './PutUrl';

const Bucket = Type.Object({
  action: Type.String(),
  bucket_id: Type.String(),
  put_url: BucketPutUrl
});

export default Bucket;
