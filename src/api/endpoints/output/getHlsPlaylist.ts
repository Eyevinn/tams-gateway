import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import { MangoSelector } from 'nano';
import { flowsClient, segmentsClient } from '../../../db/client';
import ErrorResponse from '../../utils/error-response';
import createS3URL from '../../utils/createS3URL';
import { overlapBounds } from '../../utils/timerange';
import httpError from '../../utils/http-error';
import { buildMediaPlaylist, HlsSegment } from '../../utils/hlsManifest';
import {
  DEFAULT_HLS_URL_TTL,
  DEFAULT_LIVE_RECENCY_WINDOW
} from '../../../config';

// Mirrors listSegments' DEFAULT_LIMIT so the manifest covers the same window
// shape as the segments endpoint (ADR-006 D2).
const DEFAULT_LIMIT = 1000;

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

  if (latestTsEnd) {
    // Live if the most recent segment ended within LIVE_RECENCY_WINDOW of now,
    // i.e. ts_end >= now - window. (A ts_end at/after now also satisfies this.)
    // ts_end is TAI nanoseconds while Date.now() is UTC milliseconds, a ~37s
    // skew in 2026. The skew is direction-safe: TAI runs ahead of UTC, so a live
    // flow's ts_end reads as MORE recent than UTC-now, only ever biasing toward
    // "live", never misclassifying a live flow as VOD. ?type is the authoritative
    // override when exact behaviour is required (ADR-006 D3).
    const nowNs = BigInt(Date.now()) * 1_000_000n;
    const windowNs = BigInt(Math.round(liveRecencyWindowSec() * 1e9));
    return BigInt(latestTsEnd) >= nowNs - windowNs;
  }
  return false;
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

    // (5) Main query. For live without an explicit timerange, fetch the most
    // recent N segments (descending) and reverse to play order so the playlist
    // sits at the live edge and advances on reload as the producer appends.
    // Otherwise read ascending from the start (or within the timerange window).
    const liveLatest = isLive && !timerange;
    const result = await segmentsClient.find({
      selector,
      sort: [
        { flow_id: liveLatest ? 'desc' : 'asc' },
        { ts_start: liveLatest ? 'desc' : 'asc' }
      ],
      limit: limit ?? DEFAULT_LIMIT
    });
    const docs = liveLatest ? [...result.docs].reverse() : result.docs;

    // (6) Media sequence = count of this flow's segments strictly before the
    // first segment in the window. 0 when the window starts at the flow start
    // (VOD from the beginning); non-zero and increasing for a live latest-N
    // window or a timerange window, which keeps hls.js live reloads monotonic.
    let mediaSequence = 0;
    if (docs.length > 0 && (liveLatest || timerange)) {
      const before = await segmentsClient.find({
        selector: { flow_id: id, ts_start: { $lt: docs[0].ts_start } },
        fields: ['_id'],
        limit: 1_000_000
      });
      mediaSequence = before.docs.length;
    }

    // (7) Presign each object with the longer HLS TTL (D6) and build segments.
    const segments: HlsSegment[] = await Promise.all(
      docs.map(async (doc) => ({
        ts_start: doc.ts_start,
        ts_end: doc.ts_end,
        uri: await createS3URL('GET', doc.object_id, { expiresIn: hlsUrlTtl() })
      }))
    );

    // (8) Build the playlist.
    const playlist = buildMediaPlaylist({ isLive, mediaSequence, segments });

    // (9) Reply. Live manifests must never be cached; VOD may be cached briefly
    // but below the presigned-URL TTL.
    reply
      .header('Content-Type', HLS_CONTENT_TYPE)
      .header(
        'Cache-Control',
        isLive ? 'no-store' : `max-age=${Math.min(60, hlsUrlTtl())}`
      )
      .code(200)
      .send(playlist);
  });
  next();
};

export default getHlsPlaylist;
