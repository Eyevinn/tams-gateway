// Centralized runtime configuration.
//
// loadConfig() is called once at startup (not at import time, so tests that
// import modules without a full environment do not fail). It validates the
// required environment variables and fails fast with a clear message listing
// everything that is missing.

import Logger from './utils/Logger';

export interface Config {
  port: number;
  awsRegion: string;
  corsOrigin: string[] | boolean;
  logLevel: string;
  apiToken?: string;
  // HLS output (ADR-006). hlsUrlTtl is the presigned-URL lifetime (seconds) for
  // segment URIs in a manifest; liveRecencyWindow is how recent the latest
  // segment must be (seconds) for the recency fallback to classify a flow live.
  hlsUrlTtl: number;
  liveRecencyWindow: number;
  // Built-in read-only inspector UI (ADR-007 D4). When true, the gateway serves
  // static assets and the /ui route; when false they are not registered at all
  // (lean conformance API). Optional, NOT in REQUIRED_ENV, default ON.
  enableUi: boolean;
}

// Shared defaults so a single source defines them. createS3URL reads the region
// from the environment directly (the AWS SDK is env-driven) but falls back to
// the same default rather than duplicating the literal.
export const DEFAULT_PORT = 8000;
export const DEFAULT_AWS_REGION = 'eu-north-1';
export const DEFAULT_LOG_LEVEL = 'info';
// HLS output defaults (ADR-006 D6/D3). 6h presigned-URL TTL outlives a typical
// VOD session; 30s recency window for live-vs-VOD fallback.
export const DEFAULT_HLS_URL_TTL = 21600;
export const DEFAULT_LIVE_RECENCY_WINDOW = 30;
// Live playlist span in seconds: a DVR window ending at the live edge (default
// 5 minutes), not the whole flow. Big enough for a few -10s jumps.
export const DEFAULT_LIVE_WINDOW_SEC = 300;
// Inspector UI defaults ON (ADR-007 D4): the inspector is the human value of
// "single-click runnable", is read-only and cheap. Set ENABLE_UI=false to drop it.
export const DEFAULT_ENABLE_UI = true;
// Per-webhook delivery timeout (ms) for outbound event POSTs. A slow or hung
// subscriber must not stall the API request that triggered the event.
export const DEFAULT_WEBHOOK_TIMEOUT_MS = 5000;

// Parse a boolean env var. Treats unset as the provided default; "false"/"0"/"no"
// (case-insensitive) as false; everything else present as true.
export const parseBool = (
  value: string | undefined,
  fallback: boolean
): boolean => {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (v === 'false' || v === '0' || v === 'no' || v === '') return false;
  return true;
};

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
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}`
    );
  }

  // API_TOKEN is optional. When set, the gateway enforces its own bearer token
  // (see api.ts). When unset, authentication is delegated to the surrounding
  // deployment, i.e. an upstream authenticating proxy / access gate such as the
  // OSC ingress gate, which validates the caller before the request reaches the
  // gateway. We warn (rather than fail) in production so an accidentally
  // unprotected deploy is visible, without blocking gate-fronted deployments that
  // intentionally run without a gateway-level token.
  if (process.env.NODE_ENV === 'production' && !process.env.API_TOKEN) {
    Logger.yellow(
      'WARNING: running in production without API_TOKEN; the gateway will not ' +
        'enforce its own bearer auth. Ensure an upstream authenticating ' +
        'proxy/gate protects this service before exposing it.'
    );
  }

  return {
    port: process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT,
    awsRegion: process.env.AWS_REGION || DEFAULT_AWS_REGION,
    corsOrigin: parseCorsOrigin(process.env.CORS_ORIGIN),
    logLevel: process.env.LOG_LEVEL || DEFAULT_LOG_LEVEL,
    apiToken: process.env.API_TOKEN,
    hlsUrlTtl: process.env.HLS_URL_TTL
      ? Number(process.env.HLS_URL_TTL)
      : DEFAULT_HLS_URL_TTL,
    liveRecencyWindow: process.env.LIVE_RECENCY_WINDOW
      ? Number(process.env.LIVE_RECENCY_WINDOW)
      : DEFAULT_LIVE_RECENCY_WINDOW,
    enableUi: parseBool(process.env.ENABLE_UI, DEFAULT_ENABLE_UI)
  };
};
