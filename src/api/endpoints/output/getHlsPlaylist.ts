import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import { MangoSelector } from 'nano';
import { flowsClient, segmentsClient } from '../../../db/client';
import ErrorResponse from '../../utils/error-response';
import createS3URL from '../../utils/createS3URL';
import { overlapBounds, toKey } from '../../utils/timerange';
import httpError from '../../utils/http-error';
import { buildMediaPlaylist, HlsSegment } from '../../utils/hlsManifest';
import {
  DEFAULT_HLS_URL_TTL,
  DEFAULT_LIVE_RECENCY_WINDOW,
  DEFAULT_LIVE_WINDOW_SEC
} from '../../../config';

// Mirrors listSegments' DEFAULT_LIMIT; bounds the live DVR window query (the
// time window already keeps it small, this is just a safety ceiling).
const DEFAULT_LIMIT = 1000;
// VOD / timerange default ceiling: cover a whole recording (a few hours of 2s
// segments) so the playlist spans the full timeline instead of truncating to the
// first ~33 min. ~28h at 2s. Very long flows trade a slower manifest build for
// completeness; a segment-proxy would remove that cost (follow-up).
const VOD_MAX_SEGMENTS = 50000;

const HLS_CONTENT_TYPE = 'application/vnd.apple.mpegurl';

// Endpoint plugins read runtime config from the environment directly (same
// pattern as createS3URL), so the manifest TTL and recency window are resolved
// here rather than threaded through the API builder.
const hlsUrlTtl = (): number =>
  process.env.HLS_URL_TTL
    ? Number(process.env.HLS_URL_TTL)
    : DEFAULT_HLS_URL_TTL;
const liveRecencyWindowSec = (): number =>
  process.env.LIVE_RECENCY_WINDOW
    ? Number(process.env.LIVE_RECENCY_WINDOW)
    : DEFAULT_LIVE_RECENCY_WINDOW;
// Span of the live playlist (seconds): a small DVR window ending at the live
// edge, not the whole flow. Big enough for a few -10s jumps.
const liveWindowSec = (): number =>
  process.env.LIVE_WINDOW_SEC
    ? Number(process.env.LIVE_WINDOW_SEC)
    : DEFAULT_LIVE_WINDOW_SEC;

// Nanoseconds per segment, used as the MEDIA-SEQUENCE unit. Prefer the flow's
// declared segment_duration; fall back to 2s. Using a fixed unit (not a measured
// segment) keeps the derived sequence stable per ts_start across reloads.
const SEGMENT_UNIT_DEFAULT_NS = 2_000_000_000n;
const mediaSequenceUnitNs = (flow: {
  segment_duration?: { numerator?: number; denominator?: number };
}): bigint => {
  const sd = flow.segment_duration;
  if (sd?.numerator && sd?.denominator) {
    const ns = (BigInt(sd.numerator) * 1_000_000_000n) / BigInt(sd.denominator);
    if (ns > 0n) return ns;
  }
  return SEGMENT_UNIT_DEFAULT_NS;
};

// MPEG-TS gate (ADR-006 D4). The live mux flow has codec "video/mp2t" and
// container "video/mp2t"; container_mapping.mp2ts_container is the structured
// signal when a producer sets it.
const isMpegTs = (flow: {
  codec?: string;
  container?: string;
  container_mapping?: { mp2ts_container?: unknown };
}): boolean => {
  const mp2t = (value?: string) =>
    Boolean(value && value.startsWith('video/mp2t'));
  return (
    mp2t(flow.codec) ||
    mp2t(flow.container) ||
    flow.container_mapping?.mp2ts_container !== undefined
  );
};

// Whether the most recent segment ended within LIVE_RECENCY_WINDOW of now, i.e.
// the flow is actively producing. ts_end is TAI nanoseconds while Date.now() is
// UTC milliseconds, a ~37s skew in 2026. The skew is direction-safe: TAI runs
// ahead of UTC, so an active flow's ts_end reads as MORE recent than UTC-now,
// only ever biasing toward "recent", never the reverse.
const latestIsRecent = (latestTsEnd: string | null): boolean => {
  if (!latestTsEnd) return false;
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const windowNs = BigInt(Math.round(liveRecencyWindowSec() * 1e9));
  return BigInt(latestTsEnd) >= nowNs - windowNs;
};

// Live-vs-VOD resolution (ADR-006 D3), in priority order:
//   1. explicit ?type wins;
//   2. tags.flow_status === 'ingesting' OR an open-ended flow.timerange;
//   3. recency fallback: latest segment ts_end within LIVE_RECENCY_WINDOW of now.
const resolveIsLive = (
  flow: { tags?: Record<string, string>; timerange?: string },
  type: 'live' | 'vod' | undefined,
  latestTsEnd: string | null
): boolean => {
  if (type) {
    return type === 'live';
  }

  if (flow.tags?.flow_status === 'ingesting') {
    return true;
  }
  if (flow.timerange) {
    // An open upper bound (no end) marks an ongoing/live flow.
    const closeIdx = flow.timerange.search(/[\])]/);
    const inner = flow.timerange.replace(/^[[(]/, '').replace(/[\])]$/, '');
    const end = inner.includes('_') ? inner.split('_')[1] : inner;
    if (closeIdx !== -1 && end === '') {
      return true;
    }
  }

  return latestIsRecent(latestTsEnd);
};

const opts = {
  schema: {
    tags: ['Output'],
    description: 'Get a playable HLS media playlist for a flow',
    produces: [HLS_CONTENT_TYPE],
    querystring: {
      type: 'object',
      properties: {
        timerange: { type: 'string' },
        limit: { type: 'integer', minimum: 0 },
        type: { type: 'string', enum: ['live', 'vod'] }
      }
    },
    response: {
      200: { type: 'string' }
    }
  }
};

const GetHlsPlaylistParams = Type.Object({
  id: Type.String()
});

const GetHlsPlaylistQueries = Type.Object({
  timerange: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer()),
  type: Type.Optional(Type.Union([Type.Literal('live'), Type.Literal('vod')]))
});

// Synthesise an HLS media playlist on the fly from the same Mango query
// listSegments uses, presigning each segment with createS3URL (ADR-006 D1).
const getHlsPlaylist: FastifyPluginCallback = (fastify, _, next) => {
  fastify.get<{
    Reply: string | Static<typeof ErrorResponse>;
    Params: Static<typeof GetHlsPlaylistParams>;
    Querystring: Static<typeof GetHlsPlaylistQueries>;
  }>('/flows/:id/output.m3u8', opts, async (request, reply) => {
    const { id } = request.params;
    const { timerange, limit, type } = request.query;

    // (1) Flow lookup -> 404 on miss.
    let flow;
    try {
      flow = await flowsClient.get(id);
    } catch (e: unknown) {
      if ((e as { statusCode?: number }).statusCode === 404) {
        throw httpError(404, `Flow "${id}" not found`);
      }
      throw e;
    }

    // (2) Container gate (D4) -> 415 for non-MPEG-TS flows.
    if (!isMpegTs(flow)) {
      throw httpError(
        415,
        `Flow "${id}" is not MPEG-TS; HLS output is unavailable`
      );
    }

    // (3) Build the same selector listSegments uses. An unparseable timerange is
    // a client error (400), parsed before any DB call.
    const selector: MangoSelector = { flow_id: id };
    if (timerange) {
      let bounds: ReturnType<typeof overlapBounds>;
      try {
        bounds = overlapBounds(timerange);
      } catch {
        throw httpError(400, `Invalid timerange "${timerange}"`);
      }
      if (bounds.startBelow !== null) {
        selector.ts_start = { [bounds.startOp]: bounds.startBelow };
      }
      if (bounds.endAbove !== null) {
        selector.ts_end = { [bounds.endOp]: bounds.endAbove };
      }
    }

    // (4) Live-vs-VOD must be resolved BEFORE the main query: a live flow serves
    // the LATEST window (the live edge), VOD serves from the start. The recency
    // fallback needs the most-recent segment, so probe it first (cheap, limit 1).
    // When ?type is explicit (the usual case) the probe value is unused.
    const latest = await segmentsClient.find({
      selector: { flow_id: id },
      sort: [{ flow_id: 'desc' }, { ts_start: 'desc' }],
      limit: 1
    });
    const latestTsEnd: string | null = latest.docs[0]?.ts_end ?? null;
    const isLive = resolveIsLive(flow, type, latestTsEnd);

    // (5) Main query. For live without an explicit timerange, restrict to a
    // recent DVR window (the last liveWindowSec seconds, ending at the live edge)
    // so the playlist is small and sits at the edge, advancing on reload as the
    // producer appends. Otherwise read from the start (or the timerange window).
    const liveLatest = isLive && !timerange;
    if (liveLatest && latestTsEnd) {
      const windowStartNs =
        BigInt(latestTsEnd) - BigInt(liveWindowSec()) * 1_000_000_000n;
      selector.ts_start = {
        $gte: toKey(windowStartNs > 0n ? windowStartNs : 0n)
      };
    }
    const result = await segmentsClient.find({
      selector,
      sort: [{ flow_id: 'asc' }, { ts_start: 'asc' }],
      // Live is bounded by the time window above; VOD/timerange span the whole
      // recording so the player timeline is not truncated to the first ~33 min.
      limit: limit ?? (liveLatest ? DEFAULT_LIMIT : VOD_MAX_SEGMENTS)
    });
    const docs = result.docs;

    // (6) Media sequence. HLS only needs it stable per-segment and monotonic
    // across reloads (gaps are tolerated), so derive it from the first segment's
    // start in units of the segment duration, rather than counting all prior
    // segments. The count query was O(flow length) and dominated live-reload
    // latency (hundreds of ms, growing without bound). VOD from the start
    // conventionally begins at 0.
    let mediaSequence = 0;
    if (docs.length > 0 && (liveLatest || timerange)) {
      mediaSequence = Number(
        BigInt(docs[0].ts_start) / mediaSequenceUnitNs(flow)
      );
    }

    // (7) Presign each object with the longer HLS TTL (D6) and build segments.
    // Pin signing to the current hour so a segment presigns to the SAME URL
    // across reloads (stable HLS segment URLs); otherwise fresh signatures every
    // reload make hls.js treat a live playlist as constantly changing and hammer
    // the manifest.
    const signingDate = new Date(
      Math.floor(Date.now() / 3_600_000) * 3_600_000
    );
    const segments: HlsSegment[] = await Promise.all(
      docs.map(async (doc) => ({
        ts_start: doc.ts_start,
        ts_end: doc.ts_end,
        uri: await createS3URL('GET', doc.object_id, {
          expiresIn: hlsUrlTtl(),
          signingDate
        })
      }))
    );

    // (8) Build the playlist. A live playlist is left open (no EXT-X-ENDLIST)
    // ONLY while the flow is actively producing; if the latest segment is stale
    // (the producer stopped), close it with ENDLIST even for ?type=live so the
    // player plays the window and stops polling, instead of hammering the
    // manifest a few times a second looking for segments that never arrive.
    const activelyLive = isLive && latestIsRecent(latestTsEnd);
    const playlist = buildMediaPlaylist({
      isLive: activelyLive,
      mediaSequence,
      segments
    });

    // (9) Reply. An open live manifest must never be cached; a closed one may be
    // cached briefly, below the presigned-URL TTL.
    reply
      .header('Content-Type', HLS_CONTENT_TYPE)
      .header(
        'Cache-Control',
        activelyLive ? 'no-store' : `max-age=${Math.min(60, hlsUrlTtl())}`
      )
      .code(200)
      .send(playlist);
  });
  next();
};

export default getHlsPlaylist;
