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

  it('reports MEDIA-SEQUENCE from the count of earlier segments for a windowed request, and caches VOD', async () => {
    flows.get.mockResolvedValue(MPEG_TS_FLOW);
    segments.find
      .mockResolvedValueOnce({ docs: [SEG_DOCS[1]] }) // (1) recency probe
      .mockResolvedValueOnce({ docs: SEG_DOCS }) // (2) main window query
      .mockResolvedValueOnce({ docs: new Array(5).fill({ _id: 'x' }) }); // (3) count of earlier segments

    const app = buildApp();
    // timerange "[0:0_100:0)" url-encoded; triggers the mediaSequence count path.
    const res = await app.inject({
      method: 'GET',
      url: '/flows/flow-1/output.m3u8?type=vod&timerange=%5B0%3A0_100%3A0%29'
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('#EXT-X-MEDIA-SEQUENCE:5');
    expect(segments.find).toHaveBeenCalledTimes(3);
    // VOD is briefly cacheable (capped below the presigned-URL TTL), not no-store.
    expect(res.headers['cache-control']).toContain('max-age=');
    await app.close();
  });

  it('honours ?type=live and serves a recent live window at the edge', async () => {
    flows.get.mockResolvedValue(MPEG_TS_FLOW);
    segments.find
      .mockResolvedValueOnce({ docs: [SEG_DOCS[1]] }) // (1) recency probe -> latest ts_end
      .mockResolvedValueOnce({ docs: SEG_DOCS }) // (2) main window query
      .mockResolvedValueOnce({ docs: [] }); // (3) count before window -> mediaSequence 0

    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/flows/flow-1/output.m3u8?type=live'
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('#EXT-X-PLAYLIST-TYPE');
    expect(res.body).not.toContain('#EXT-X-ENDLIST');
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
});
