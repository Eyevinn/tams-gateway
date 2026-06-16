import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from './config';

const REQUIRED = [
  'DB_URL',
  'DB_USERNAME',
  'DB_PASSWORD',
  'S3_BUCKET',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY'
];

describe('loadConfig', () => {
  let saved: NodeJS.ProcessEnv;

  beforeEach(() => {
    saved = { ...process.env };
    for (const key of REQUIRED) {
      process.env[key] = 'x';
    }
    delete process.env.PORT;
    delete process.env.AWS_REGION;
    delete process.env.CORS_ORIGIN;
    delete process.env.LOG_LEVEL;
    delete process.env.API_TOKEN;
  });

  afterEach(() => {
    process.env = saved;
  });

  it('returns defaults when all required vars are set', () => {
    const config = loadConfig();
    expect(config.port).toBe(8000);
    expect(config.awsRegion).toBe('eu-north-1');
    expect(config.corsOrigin).toBe(true);
    expect(config.logLevel).toBe('info');
  });

  it('throws listing every missing required var', () => {
    delete process.env.DB_URL;
    delete process.env.S3_BUCKET;
    expect(() => loadConfig()).toThrow(/DB_URL/);
    expect(() => loadConfig()).toThrow(/S3_BUCKET/);
  });

  it('does not require S3_ENDPOINT_URL (AWS resolves the endpoint from region)', () => {
    delete process.env.S3_ENDPOINT_URL;
    expect(() => loadConfig()).not.toThrow();
  });

  it('requires API_TOKEN in production', () => {
    process.env.NODE_ENV = 'production';
    expect(() => loadConfig()).toThrow(/API_TOKEN/);
  });

  it('does not require API_TOKEN outside production', () => {
    expect(() => loadConfig()).not.toThrow();
  });

  it('parses PORT and comma-separated CORS origins', () => {
    process.env.PORT = '8080';
    process.env.CORS_ORIGIN = 'https://a.example, https://b.example';
    const config = loadConfig();
    expect(config.port).toBe(8080);
    expect(config.corsOrigin).toEqual([
      'https://a.example',
      'https://b.example'
    ]);
  });
});
