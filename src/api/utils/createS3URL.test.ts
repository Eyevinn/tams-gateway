import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import createS3URL from './createS3URL';

// getSignedUrl runs entirely offline (no network), so we can assert the shape of
// the presigned URL for both the explicit-endpoint (MinIO) and AWS-resolved cases.
describe('createS3URL', () => {
  let saved: NodeJS.ProcessEnv;

  beforeEach(() => {
    saved = { ...process.env };
    process.env.AWS_ACCESS_KEY_ID = 'AKIAEXAMPLE';
    process.env.AWS_SECRET_ACCESS_KEY = 'secretexamplevalue';
    process.env.AWS_REGION = 'eu-north-1';
  });

  afterEach(() => {
    process.env = saved;
  });

  it('presigns a path-style URL against an explicit endpoint (MinIO)', async () => {
    process.env.S3_ENDPOINT_URL = 'https://minio.example.com';
    const url = await createS3URL('PUT', 'tams/object-1');
    expect(url).toContain('https://minio.example.com/tams/object-1');
    expect(url).toContain('X-Amz-Signature');
    expect(url).not.toContain('undefined');
  });

  it('presigns an AWS region-resolved URL when no endpoint is set', async () => {
    delete process.env.S3_ENDPOINT_URL;
    const url = await createS3URL('GET', 'tams/object-2');
    // Virtual-hosted AWS URL derived from region + bucket, no custom endpoint.
    expect(url).toContain('amazonaws.com');
    expect(url).toContain('tams');
    expect(url).toContain('object-2');
    expect(url).toContain('X-Amz-Signature');
    expect(url).not.toContain('undefined');
  });
});
