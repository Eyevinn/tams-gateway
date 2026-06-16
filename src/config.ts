// Centralized runtime configuration.
//
// loadConfig() is called once at startup (not at import time, so tests that
// import modules without a full environment do not fail). It validates the
// required environment variables and fails fast with a clear message listing
// everything that is missing.

export interface Config {
  port: number;
  awsRegion: string;
  corsOrigin: string[] | boolean;
  logLevel: string;
  apiToken?: string;
}

// Shared defaults so a single source defines them. createS3URL reads the region
// from the environment directly (the AWS SDK is env-driven) but falls back to
// the same default rather than duplicating the literal.
export const DEFAULT_PORT = 8000;
export const DEFAULT_AWS_REGION = 'eu-north-1';
export const DEFAULT_LOG_LEVEL = 'info';

// Parse a comma-separated CORS_ORIGIN allow-list, or `true` (reflect any origin)
// when it is unset.
export const parseCorsOrigin = (
  value: string | undefined
): string[] | boolean =>
  value ? value.split(',').map((origin) => origin.trim()) : true;

// Variables that must be present for the gateway to operate. DB credentials are
// consumed by the CouchDB client; AWS credentials are read from the environment
// by the AWS SDK when presigning S3 URLs. S3_ENDPOINT_URL is intentionally NOT
// required: when set it targets an S3-compatible endpoint (e.g. MinIO,
// path-style), when unset the AWS SDK resolves the native AWS S3 endpoint from
// AWS_REGION and the bucket. See createS3URL.
const REQUIRED_ENV = [
  'DB_URL',
  'DB_USERNAME',
  'DB_PASSWORD',
  'S3_BUCKET',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY'
];

export const loadConfig = (): Config => {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  // API_TOKEN is optional in development but required in production so the
  // service is never deployed with authentication accidentally disabled.
  if (process.env.NODE_ENV === 'production' && !process.env.API_TOKEN) {
    missing.push('API_TOKEN');
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}`
    );
  }

  return {
    port: process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT,
    awsRegion: process.env.AWS_REGION || DEFAULT_AWS_REGION,
    corsOrigin: parseCorsOrigin(process.env.CORS_ORIGIN),
    logLevel: process.env.LOG_LEVEL || DEFAULT_LOG_LEVEL,
    apiToken: process.env.API_TOKEN
  };
};
