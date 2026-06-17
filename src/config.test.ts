import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

  it('does not require API_TOKEN in production, but warns (auth delegated to an upstream gate when unset)', () => {
    process.env.NODE_ENV = 'production';
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(() => loadConfig()).not.toThrow();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('API_TOKEN'));
    log.mockRestore();
  });

  it('does not warn about a missing API_TOKEN outside production', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(() => loadConfig()).not.toThrow();
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('API_TOKEN'));
    log.mockRestore();
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
