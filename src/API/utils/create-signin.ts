import crypto from 'crypto';
import Logger from '../../utils/Logger';

const createSignin = () => {
  const date = '20250506T075639Z';
  const region = 'eu-north-1';
  const url = 'eyevinnlab-tamspocstorage.minio-minio.auto.prod.osaas.io';
  const dateShort = '20250506';
  const secretKey = 'tamspoc';
  const secretAccessKey = 'tams-poc-secret';
  // const region = 'us-east-1';
  // const url = 'https://examplebucket.s3.amazonaws.com';
  // const date = '20130524T000000Z';
  // const dateShort = '20130524';
  const service = 's3';
  // const url = 'examplebucket.s3.amazonaws.com';
  // const region = 'us-east-1';
  // const secretKey = 'AKIAIOSFODNN7EXAMPLE';
  // const secretAccessKey = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

  const canonicalRequest = `GET\n\n\nhost:${url}\nx-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\nx-amz-date:${date}\n\nhost;range;x-amz-content-sha256;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`;

  const hashed = crypto
    .createHash('sha256')
    .update(canonicalRequest)
    .digest('hex');

  Logger.red(hashed);

  const stringToSign = `AWS4-HMAC-SHA256\n${date}\n${dateShort}/${region}/s3/aws4_request\n${hashed}`;

  Logger.black(stringToSign);

  const DateKey = crypto
    .createHmac('sha256', `AWS4${secretAccessKey}`)
    .update(dateShort)
    .digest('hex');
  const DateRegionKey = crypto
    .createHmac('sha256', DateKey, { encoding: 'hex' })
    .update(region)
    .digest('hex');
  const DateRegionServiceKey = crypto
    .createHmac('sha256', DateRegionKey, { encoding: 'hex' })
    .update(service)
    .digest('hex');
  const SigninKey = crypto
    .createHmac('sha256', DateRegionServiceKey, { encoding: 'hex' })
    .update('aws4_request')
    .digest('hex');
  const key = crypto
    .createHmac('sha256', SigninKey, { encoding: 'hex' })
    .update(stringToSign)
    .digest('hex');

  Logger.green(
    `AWS4-HMAC-SHA256 Credential=${secretKey}/${dateShort}/${region}/${service}/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date,Signature=${key}`
  );
  Logger.green('AWS ' + secretKey + ':' + key);
  Logger.cyan(key);
  return key;
};

export default createSignin;
