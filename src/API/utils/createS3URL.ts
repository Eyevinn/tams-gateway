import { S3RequestPresigner } from '@aws-sdk/s3-request-presigner';
import { parseUrl } from '@smithy/url-parser';
import { Hash } from '@smithy/hash-node';
import { fromEnv } from '@aws-sdk/credential-providers';
import { HttpRequest } from '@smithy/protocol-http';
import { formatUrl } from '@aws-sdk/util-format-url';

export type S3Methods = 'GET' | 'PUT' | 'POST' | 'DELETE';

export const createBucketBody =
  '<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">\n<LocationConstraint>default</LocationConstraint>\n</CreateBucketConfiguration >';

const createS3URL = async (method: S3Methods, bucketName: string) => {
  const url = parseUrl(
    `https://eyevinnlab-tamspocstorage.minio-minio.auto.prod.osaas.io/${bucketName}`
  );
  const presigner = new S3RequestPresigner({
    credentials: fromEnv(),
    region: 'eu-north-1',
    sha256: Hash.bind(null, 'sha256')
  });

  const signedUrlObject = await presigner.presign(
    new HttpRequest({ ...url, method })
  );
  return formatUrl(signedUrlObject);
};

export default createS3URL;
