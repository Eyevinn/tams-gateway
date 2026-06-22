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
    // First find: the window query; second find: latest-segment recency probe.
    segments.find
      .mockResolvedValueOnce({ docs: SEG_DOCS })
      .mockResolvedValueOnce({ docs: [SEG_DOCS[1]] });

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

  it('honours ?type=live (no PLAYLIST-TYPE / ENDLIST) over recency', async () => {
    flows.get.mockResolvedValue(MPEG_TS_FLOW);
    segments.find
      .mockResolvedValueOnce({ docs: SEG_DOCS })
      .mockResolvedValueOnce({ docs: [SEG_DOCS[1]] });

    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/flows/flow-1/output.m3u8?type=live'
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('#EXT-X-PLAYLIST-TYPE');
    expect(res.body).not.toContain('#EXT-X-ENDLIST');
    expect(res.headers['cache-control']).toBe('no-store');
    await app.close();
  });
});
