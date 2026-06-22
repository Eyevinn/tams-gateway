import { describe, it, expect } from 'vitest';
import { buildMediaPlaylist, HlsSegment } from './hlsManifest';

// Helper: a 2-second segment starting at the given second, as 20-digit ns keys.
const seg = (startSec: number, durSec: number, uri: string): HlsSegment => {
  const ns = (s: number) =>
    (BigInt(s) * 1_000_000_000n).toString().padStart(20, '0');
  return { ts_start: ns(startSec), ts_end: ns(startSec + durSec), uri };
};

describe('buildMediaPlaylist', () => {
  it('builds a golden VOD playlist (PLAYLIST-TYPE:VOD + ENDLIST)', () => {
    const m3u8 = buildMediaPlaylist({
      isLive: false,
      mediaSequence: 0,
      segments: [
        seg(0, 2, 'https://s3/seg0.ts'),
        seg(2, 2, 'https://s3/seg1.ts')
      ]
    });

    const lines = m3u8.split('\n');
    expect(lines[0]).toBe('#EXTM3U');
    expect(m3u8).toContain('#EXT-X-VERSION:3');
    expect(m3u8).toContain('#EXT-X-TARGETDURATION:2');
    expect(m3u8).toContain('#EXT-X-MEDIA-SEQUENCE:0');
    expect(m3u8).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
    expect(m3u8).toContain('#EXTINF:2.000,');
    expect(m3u8).toContain('https://s3/seg0.ts');
    expect(m3u8).toContain('https://s3/seg1.ts');
    expect(m3u8).toContain('#EXT-X-ENDLIST');
    // Exactly one EXTINF per segment.
    expect((m3u8.match(/#EXTINF:/g) || []).length).toBe(2);
  });

  it('builds a live playlist with neither PLAYLIST-TYPE nor ENDLIST', () => {
    const m3u8 = buildMediaPlaylist({
      isLive: true,
      mediaSequence: 42,
      segments: [seg(0, 2, 'https://s3/seg0.ts')]
    });

    expect(m3u8).toContain('#EXT-X-MEDIA-SEQUENCE:42');
    expect(m3u8).not.toContain('#EXT-X-PLAYLIST-TYPE');
    expect(m3u8).not.toContain('#EXT-X-ENDLIST');
  });

  it('emits exactly one DISCONTINUITY across a timeline gap', () => {
    // seg0 ends at 2s, seg1 starts at 5s (gap), seg2 starts where seg1 ends.
    const m3u8 = buildMediaPlaylist({
      isLive: false,
      mediaSequence: 0,
      segments: [
        seg(0, 2, 'https://s3/seg0.ts'),
        seg(5, 2, 'https://s3/seg1.ts'),
        seg(7, 2, 'https://s3/seg2.ts')
      ]
    });
    expect((m3u8.match(/#EXT-X-DISCONTINUITY/g) || []).length).toBe(1);
  });

  it('emits no DISCONTINUITY for a contiguous timeline', () => {
    const m3u8 = buildMediaPlaylist({
      isLive: false,
      mediaSequence: 0,
      segments: [
        seg(0, 2, 'https://s3/seg0.ts'),
        seg(2, 2, 'https://s3/seg1.ts'),
        seg(4, 2, 'https://s3/seg2.ts')
      ]
    });
    expect(m3u8).not.toContain('#EXT-X-DISCONTINUITY');
  });

  it('returns header-only (+ ENDLIST for VOD) for an empty window', () => {
    const vod = buildMediaPlaylist({
      isLive: false,
      mediaSequence: 0,
      segments: []
    });
    expect(vod).toContain('#EXTM3U');
    expect(vod).toContain('#EXT-X-TARGETDURATION:1');
    expect(vod).toContain('#EXT-X-ENDLIST');
    expect(vod).not.toContain('#EXTINF');

    const live = buildMediaPlaylist({
      isLive: true,
      mediaSequence: 0,
      segments: []
    });
    expect(live).not.toContain('#EXT-X-ENDLIST');
    expect(live).not.toContain('#EXTINF');
  });

  it('formats PROGRAM-DATE-TIME as an ISO 8601 string from ts_start', () => {
    // 1_700_000_000 s = 2023-11-14T22:13:20.000Z.
    const ts_start = (1_700_000_000n * 1_000_000_000n)
      .toString()
      .padStart(20, '0');
    const ts_end = ((1_700_000_000n + 2n) * 1_000_000_000n)
      .toString()
      .padStart(20, '0');
    const m3u8 = buildMediaPlaylist({
      isLive: true,
      mediaSequence: 0,
      segments: [{ ts_start, ts_end, uri: 'https://s3/seg.ts' }]
    });
    expect(m3u8).toContain('#EXT-X-PROGRAM-DATE-TIME:2023-11-14T22:13:20.000Z');
  });

  it('sets TARGETDURATION to ceil(max EXTINF)', () => {
    // A 2.5s and a 2s segment => max EXTINF 2.5 => TARGETDURATION 3.
    const longer = {
      ts_start: '0'.repeat(20),
      ts_end: 2_500_000_000n.toString().padStart(20, '0'),
      uri: 'https://s3/a.ts'
    };
    const m3u8 = buildMediaPlaylist({
      isLive: false,
      mediaSequence: 0,
      segments: [longer, seg(3, 2, 'https://s3/b.ts')]
    });
    expect(m3u8).toContain('#EXT-X-TARGETDURATION:3');
    expect(m3u8).toContain('#EXTINF:2.500,');
  });
});
