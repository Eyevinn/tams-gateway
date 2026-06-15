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
}

// Variables that must be present for the gateway to operate. DB credentials are
// consumed by the CouchDB client; AWS credentials are read from the environment
// by the AWS SDK when presigning S3 URLs.
const REQUIRED_ENV = [
  'DB_URL',
  'DB_USERNAME',
  'DB_PASSWORD',
  'S3_ENDPOINT_URL',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY'
];

export const loadConfig = (): Config => {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}`
    );
  }

  return {
    port: process.env.PORT ? Number(process.env.PORT) : 8000,
    awsRegion: process.env.AWS_REGION || 'eu-north-1',
    corsOrigin: process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(',').map((origin) => origin.trim())
      : true,
    logLevel: process.env.LOG_LEVEL || 'info'
  };
};
