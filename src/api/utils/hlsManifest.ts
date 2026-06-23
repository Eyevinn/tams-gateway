// Pure HLS media-playlist builder (ADR-006, Phase 1).
//
// No Fastify, no DB, no S3: given an ordered list of segments (URIs already
// presigned) plus the live/VOD flag and the starting media sequence, it returns
// the m3u8 string. Keeping it pure makes the manifest mapping (ADR-006 D3)
// trivially unit-testable and independent of how the segments were fetched.
//
// Timestamps are the 20-digit zero-padded nanosecond keys (ts_start / ts_end,
// see src/api/utils/timerange.ts). All duration/time math is BigInt-based so the
// nanosecond counts never lose precision through a JS Number.

const NS_PER_MS = 1_000_000n;

export interface HlsSegment {
  ts_start: string;
  ts_end: string;
  uri: string;
}

export interface HlsBuildInput {
  isLive: boolean;
  mediaSequence: number;
  // Ordered ts_start ascending; URIs already presigned.
  segments: HlsSegment[];
}

// EXTINF seconds = (ts_end - ts_start) / 1e9, 3 decimals. BigInt subtraction
// keeps the nanosecond difference exact; the divide-to-Number is only applied to
// the (small) per-segment duration, which is well within Number precision.
const extinfSeconds = (segment: HlsSegment): number =>
  Number(BigInt(segment.ts_end) - BigInt(segment.ts_start)) / 1e9;

// PROGRAM-DATE-TIME is the segment's civil wall-clock time. TAMS ts_start is TAI
// nanoseconds; TAI runs 37s ahead of UTC (constant since 2017, no leap seconds
// since), so subtract that offset to emit real UTC. Emitting raw TAI-as-UTC put
// every PDT ~37s in the FUTURE, which is wrong per the HLS spec (PDT is the
// segment's wall-clock time) and skews any player/tool that maps PDT to
// wall-clock: live-edge placement, latency, scrubbing, discontinuity alignment.
const TAI_UTC_OFFSET_MS = 37_000;
const programDateTime = (segment: HlsSegment): string =>
  new Date(
    Number(BigInt(segment.ts_start) / NS_PER_MS) - TAI_UTC_OFFSET_MS
  ).toISOString();

export function buildMediaPlaylist(input: HlsBuildInput): string {
  const { isLive, mediaSequence, segments } = input;

  // TARGETDURATION must be >= the longest real segment (observed segments are
  // authoritative, ADR-006 D3); ceil to the next whole second, floor of 1.
  const maxExtinf = segments.reduce(
    (max, segment) => Math.max(max, extinfSeconds(segment)),
    0
  );
  const targetDuration = Math.max(1, Math.ceil(maxExtinf));

  const lines: string[] = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${targetDuration}`,
    `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}`
  ];

  if (!isLive) {
    lines.push('#EXT-X-PLAYLIST-TYPE:VOD');
  }

  segments.forEach((segment, i) => {
    // A timeline gap (this segment does not start exactly where the previous one
    // ended) is signalled with EXT-X-DISCONTINUITY (ADR-006 D3, reality 2).
    if (i > 0 && segment.ts_start !== segments[i - 1].ts_end) {
      lines.push('#EXT-X-DISCONTINUITY');
    }
    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${programDateTime(segment)}`);
    lines.push(`#EXTINF:${extinfSeconds(segment).toFixed(3)},`);
    lines.push(segment.uri);
  });

  if (!isLive) {
    lines.push('#EXT-X-ENDLIST');
  }

  // Trailing newline so the playlist is a well-formed text file.
  return lines.join('\n') + '\n';
}

export default buildMediaPlaylist;
