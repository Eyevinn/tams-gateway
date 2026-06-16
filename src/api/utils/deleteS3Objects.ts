import {
  DeleteObjectsCommand,
  S3Client,
  type ObjectIdentifier
} from '@aws-sdk/client-s3';
import { fromEnv } from '@aws-sdk/credential-providers';
import { DEFAULT_AWS_REGION } from '../../config';

// Result of a bulk delete: which object_ids were removed and which the store
// reported as failed (so the caller can log/surface partial failures rather
// than silently dropping them).
export interface DeleteS3ObjectsResult {
  deleted: string[];
  errors: { object_id: string; message: string }[];
}

// object_id is stored as `<bucket>/<key>` (see postStorage.ts). Split on the
// first `/` so keys that themselves contain slashes stay intact.
const parseObjectId = (
  objectId: string
): { bucket: string; key: string } | undefined => {
  const slash = objectId.indexOf('/');
  if (slash <= 0 || slash === objectId.length - 1) {
    return undefined;
  }
  return {
    bucket: objectId.slice(0, slash),
    key: objectId.slice(slash + 1)
  };
};

// Build one client per call. Mirrors createS3URL: same S3_ENDPOINT_URL, same
// env credentials, same region default. forcePathStyle keeps it working against
// S3-compatible endpoints (e.g. MinIO) where the bucket is in the path, which is
// how object_id (`<bucket>/<key>`) is already addressed elsewhere.
const buildClient = (): S3Client =>
  new S3Client({
    endpoint: process.env.S3_ENDPOINT_URL,
    region: process.env.AWS_REGION || DEFAULT_AWS_REGION,
    credentials: fromEnv(),
    forcePathStyle: true
  });

// Permanently delete the given media objects from the object store. Objects are
// grouped by bucket and removed with one DeleteObjects (bulk) request per
// bucket. Malformed object_ids (no `<bucket>/<key>` shape) are reported as
// errors rather than thrown, so a single bad value never aborts the rest.
const deleteS3Objects = async (
  objectIds: string[]
): Promise<DeleteS3ObjectsResult> => {
  const result: DeleteS3ObjectsResult = { deleted: [], errors: [] };
  if (objectIds.length === 0) {
    return result;
  }

  // Group keys per bucket; remember which object_id each (bucket,key) came from
  // so we can report back in the caller's object_id terms.
  const byBucket = new Map<string, Map<string, string>>();
  for (const objectId of objectIds) {
    const parsed = parseObjectId(objectId);
    if (!parsed) {
      result.errors.push({
        object_id: objectId,
        message: 'malformed object_id, expected "<bucket>/<key>"'
      });
      continue;
    }
    const keys = byBucket.get(parsed.bucket) ?? new Map<string, string>();
    keys.set(parsed.key, objectId);
    byBucket.set(parsed.bucket, keys);
  }

  if (byBucket.size === 0) {
    return result;
  }

  const client = buildClient();
  try {
    for (const [bucket, keyToObjectId] of byBucket) {
      const objects: ObjectIdentifier[] = [...keyToObjectId.keys()].map(
        (Key) => ({ Key })
      );

      const response = await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects, Quiet: false }
        })
      );

      for (const deleted of response.Deleted ?? []) {
        if (deleted.Key) {
          const objectId = keyToObjectId.get(deleted.Key);
          if (objectId) {
            result.deleted.push(objectId);
          }
        }
      }
      for (const error of response.Errors ?? []) {
        const objectId = error.Key ? keyToObjectId.get(error.Key) : undefined;
        result.errors.push({
          object_id: objectId ?? `${bucket}/${error.Key ?? ''}`,
          message: error.Message ?? error.Code ?? 'unknown delete error'
        });
      }
    }
  } finally {
    client.destroy();
  }

  return result;
};

export default deleteS3Objects;
