import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

vi.mock('../../../db/client', () => ({
  flowsClient: { get: vi.fn() },
  segmentsClient: { find: vi.fn() }
}));
vi.mock('../../utils/createS3URL', () => ({
  __esModule: true,
  default: vi.fn(
    async (_method: string, key?: string) => `https://s3.example/${key}?signed`
  )
}));

import { flowsClient, segmentsClient } from '../../../db/client';
import getHlsPlaylist from './getHlsPlaylist';

const flows = flowsClient as unknown as { get: Mock };
const segments = segmentsClient as unknown as { find: Mock };

const HLS_CONTENT_TYPE = 'application/vnd.apple.mpegurl';

const MPEG_TS_FLOW = {
  id: 'flow-1',
  source_id: 'src-1',
  format: 'urn:x-nmos:format:mux',
  codec: 'video/mp2t',
  container: 'video/mp2t'
};

// Two contiguous 2s segments as 20-digit ns keys.
const ns = (s: number) =>
  (BigInt(s) * 1_000_000_000n).toString().padStart(20, '0');
const SEG_DOCS = [
  { object_id: 'bucket/seg0.ts', ts_start: ns(0), ts_end: ns(2) },
  { object_id: 'bucket/seg1.ts', ts_start: ns(2), ts_end: ns(4) }
];

const buildApp = (): FastifyInstance => {
  const app = fastify().withTypeProvider<TypeBoxTypeProvider>();
  app.register(getHlsPlaylist);
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getHlsPlaylist', () => {
  it('returns 200 with the HLS content type and a media playlist', async () => {
    flows.get.mockResolvedValue(MPEG_TS_FLOW);
    // Query order: (1) latest-segment recency probe, (2) the main window query.
    segments.find
      .mockResolvedValueOnce({ docs: [SEG_DOCS[1]] })
      .mockResolvedValueOnce({ docs: SEG_DOCS });

    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/flows/flow-1/output.m3u8?type=vod'
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain(HLS_CONTENT_TYPE);
    expect(res.body).toContain('#EXTM3U');
    expect(res.body).toContain('#EXTINF:2.000,');
    expect(res.body).toContain('https://s3.example/bucket/seg0.ts?signed');
    expect(res.body).toContain('#EXT-X-ENDLIST'); // type=vod
    await app.close();
  });

  it('returns 404 for an unknown flow', async () => {
    flows.get.mockRejectedValue({ statusCode: 404 });

    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/flows/missing/output.m3u8'
    });

    expect(res.statusCode).toBe(404);
    expect(segments.find).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 400 for an unparseable timerange', async () => {
    flows.get.mockResolvedValue(MPEG_TS_FLOW);

    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/flows/flow-1/output.m3u8?timerange=%C2%84'
    });

    expect(res.statusCode).toBe(400);
    expect(segments.find).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 415 for a non-MPEG-TS flow', async () => {
    flows.get.mockResolvedValue({
      ...MPEG_TS_FLOW,
      codec: 'audio/aac',
      container: undefined
    });

    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/flows/flow-1/output.m3u8'
    });

    expect(res.statusCode).toBe(415);
    expect(segments.find).not.toHaveBeenCalled();
    await app.close();
  });

  it('derives MEDIA-SEQUENCE from the window start (no count query) and caches VOD', async () => {
    flows.get.mockResolvedValue(MPEG_TS_FLOW);
    // Window starting at 100s; with the default 2s unit, MEDIA-SEQUENCE = 50.
    const laterDocs = [
      { object_id: 'bucket/segA.ts', ts_start: ns(100), ts_end: ns(102) },
      { object_id: 'bucket/segB.ts', ts_start: ns(102), ts_end: ns(104) }
    ];
    segments.find
      .mockResolvedValueOnce({ docs: [laterDocs[1]] }) // (1) recency probe
      .mockResolvedValueOnce({ docs: laterDocs }); // (2) main window query

    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/flows/flow-1/output.m3u8?type=vod&timerange=%5B0%3A0_1000%3A0%29'
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('#EXT-X-MEDIA-SEQUENCE:50');
    // Only the recency probe + the main query; the O(flow length) count is gone.
    expect(segments.find).toHaveBeenCalledTimes(2);
    // VOD is briefly cacheable (capped below the presigned-URL TTL), not no-store.
    expect(res.headers['cache-control']).toContain('max-age=');
    await app.close();
  });

  // A recent (≈ now) ts_end, so the flow reads as actively producing.
  const recentTsEnd = ns(Math.floor(Date.now() / 1000));

  it('honours ?type=live for an actively producing flow (open playlist at the edge)', async () => {
    flows.get.mockResolvedValue(MPEG_TS_FLOW);
    segments.find
      .mockResolvedValueOnce({ docs: [{ ts_end: recentTsEnd }] }) // (1) recency probe -> fresh
      .mockResolvedValueOnce({ docs: SEG_DOCS }); // (2) main window query

    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/flows/flow-1/output.m3u8?type=live'
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('#EXT-X-PLAYLIST-TYPE');
    expect(res.body).not.toContain('#EXT-X-ENDLIST'); // open: actively producing
    expect(res.headers['cache-control']).toBe('no-store');
    // The live fix: the main query reads a recent ascending window ending at the
    // live edge (ts_start >= edge - liveWindowSec), not the oldest segments.
    expect(segments.find.mock.calls[1][0].sort).toEqual([
      { flow_id: 'asc' },
      { ts_start: 'asc' }
    ]);
    expect(segments.find.mock.calls[1][0].selector.ts_start).toHaveProperty(
      '$gte'
    );
    await app.close();
  });

  it('closes a ?type=live playlist with ENDLIST when the flow has stopped producing', async () => {
    flows.get.mockResolvedValue(MPEG_TS_FLOW);
    // Stale latest segment (ancient ts_end) => not actively producing.
    segments.find
      .mockResolvedValueOnce({ docs: [SEG_DOCS[1]] }) // (1) recency probe -> stale
      .mockResolvedValueOnce({ docs: SEG_DOCS }); // (2) main window query

    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/flows/flow-1/output.m3u8?type=live'
    });

    expect(res.statusCode).toBe(200);
    // ENDLIST so hls.js plays the window and stops polling (no manifest hammer).
    expect(res.body).toContain('#EXT-X-ENDLIST');
    await app.close();
  });
});
