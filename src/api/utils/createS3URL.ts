import { S3RequestPresigner } from '@aws-sdk/s3-request-presigner';
import { parseUrl } from '@smithy/url-parser';
import { Hash } from '@smithy/hash-node';
import { fromEnv } from '@aws-sdk/credential-providers';
import { HttpRequest } from '@smithy/protocol-http';
import { formatUrl } from '@aws-sdk/util-format-url';
import { DEFAULT_AWS_REGION } from '../../config';

export type S3Methods = 'GET' | 'PUT' | 'POST' | 'DELETE';

// Build the object URL to presign. `key` is the object_id "<bucket>/<key>"
// (see postStorage.ts). With an explicit S3_ENDPOINT_URL (e.g. MinIO) we address
// it path-style: "<endpoint>/<bucket>/<key>". Without one we target native AWS S3
// virtual-hosted style "https://<bucket>.s3.<region>.amazonaws.com/<key>", so the
// gateway works against AWS S3 without a custom endpoint, letting the region
// determine where the request goes.
const objectUrl = (objectId: string, region: string): string => {
  const endpoint = process.env.S3_ENDPOINT_URL;
  if (endpoint) {
    return `${endpoint}/${objectId}`;
  }
  const slash = objectId.indexOf('/');
  const bucket = slash > 0 ? objectId.slice(0, slash) : objectId;
  const objectKey = slash > 0 ? objectId.slice(slash + 1) : '';
  return `https://${bucket}.s3.${region}.amazonaws.com/${objectKey}`;
};

// The presigner is reused across calls: constructing it (and resolving creds)
// per call cost real time when presigning a whole HLS playlist's segments at
// once. Region is fixed for the process lifetime, so a lazy singleton is safe.
let presignerInstance: S3RequestPresigner | undefined;
const getPresigner = (region: string): S3RequestPresigner => {
  if (!presignerInstance) {
    presignerInstance = new S3RequestPresigner({
      credentials: fromEnv(),
      region,
      sha256: Hash.bind(null, 'sha256')
    });
  }
  return presignerInstance;
};

// Create a presigned S3 URL for an object. The same object_id resolves to a PUT
// (on allocation) or GET (when listing segments) URL depending on `method`.
// `options.expiresIn` (seconds) overrides the SDK default (900s); the HLS output
// path passes a longer TTL so segment URLs in a manifest outlive a 15-min window
// (ADR-006 D6). `options.signingDate` pins the SigV4 signing time so the SAME
// object presigns to the SAME URL across calls: the HLS path passes a coarse
// (hourly) bucket so a live playlist's segment URLs stay STABLE across reloads
// instead of getting fresh signatures every time, which made hls.js treat the
// playlist as constantly changing and hammer the manifest. Omitting both keeps
// the existing fresh-900s behaviour for all other callers.
const createS3URL = async (
  method: S3Methods,
  key?: string,
  options?: { expiresIn?: number; signingDate?: Date }
): Promise<string> => {
  const region = process.env.AWS_REGION || DEFAULT_AWS_REGION;
  const url = parseUrl(objectUrl(key ?? '', region));

  const presigner = getPresigner(region);

  const presignOpts: { expiresIn?: number; signingDate?: Date } = {};
  if (options?.expiresIn !== undefined)
    presignOpts.expiresIn = options.expiresIn;
  if (options?.signingDate !== undefined)
    presignOpts.signingDate = options.signingDate;

  const signedUrlObject = await presigner.presign(
    new HttpRequest({ ...url, method }),
    presignOpts
  );
  return formatUrl(signedUrlObject);
};

export default createS3URL;
