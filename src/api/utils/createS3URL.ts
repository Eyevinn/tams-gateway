import { S3RequestPresigner } from '@aws-sdk/s3-request-presigner';
import { parseUrl } from '@smithy/url-parser';
import { Hash } from '@smithy/hash-node';
import { fromEnv } from '@aws-sdk/credential-providers';
import { HttpRequest } from '@smithy/protocol-http';
import { formatUrl } from '@aws-sdk/util-format-url';
import { DEFAULT_AWS_REGION } from '../../config';

export type S3Methods = 'GET' | 'PUT' | 'POST' | 'DELETE';

// Create a presigned S3 URL for an object. `key` is the full object path
// (`<bucket>/<key>`) appended to the endpoint, so the same value resolves to
// both PUT (on allocation) and GET (when listing segments).
const createS3URL = async (method: S3Methods, key?: string) => {
  const url = parseUrl(`${process.env.S3_ENDPOINT_URL}/${key}`);

  const presigner = new S3RequestPresigner({
    credentials: fromEnv(),
    region: process.env.AWS_REGION || DEFAULT_AWS_REGION,
    sha256: Hash.bind(null, 'sha256')
  });

  const signedUrlObject = await presigner.presign(
    new HttpRequest({ ...url, method })
  );
  return formatUrl(signedUrlObject);
};

export default createS3URL;
