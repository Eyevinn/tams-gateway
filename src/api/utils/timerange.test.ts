import { describe, it, expect } from 'vitest';
import {
  parseTimeRange,
  formatTimeRange,
  toKey,
  segmentKeys,
  overlapBounds,
  KEY_WIDTH
} from './timerange';

const NS = 1_000_000_000n;

describe('parseTimeRange', () => {
  it('parses a standard half-open range', () => {
    const range = parseTimeRange('[0:0_10:0)');
    expect(range).toEqual({
      start: 0n,
      end: 10n * NS,
      startInclusive: true,
      endInclusive: false
    });
  });

  it('honours bracket inclusivity', () => {
    const range = parseTimeRange('(1:0_2:0]');
    expect(range.startInclusive).toBe(false);
    expect(range.endInclusive).toBe(true);
  });

  it('combines seconds and nanoseconds', () => {
    const range = parseTimeRange('[5:500000000_6:0)');
    expect(range.start).toBe(5n * NS + 500_000_000n);
  });

  it('treats a bare timestamp as a single instant', () => {
    const range = parseTimeRange('7:0');
    expect(range).toEqual({
      start: 7n * NS,
      end: 7n * NS,
      startInclusive: true,
      endInclusive: true
    });
  });

  it('treats a bracketed single timestamp as an instant [t,t]', () => {
    // Spec: "[10:0]" is instantaneous, equivalent to "[10:0_10:0]".
    expect(parseTimeRange('[10:0]')).toEqual({
      start: 10n * NS,
      end: 10n * NS,
      startInclusive: true,
      endInclusive: true
    });
  });

  it('parses an open start', () => {
    const range = parseTimeRange('_10:0)');
    expect(range.start).toBeNull();
    expect(range.end).toBe(10n * NS);
  });

  it('parses an open end', () => {
    const range = parseTimeRange('[10:0_');
    expect(range.start).toBe(10n * NS);
    expect(range.end).toBeNull();
  });

  it('rejects an empty timerange', () => {
    expect(() => parseTimeRange('')).toThrow();
  });

  it('rejects a malformed timestamp', () => {
    expect(() => parseTimeRange('[a:b_1:0)')).toThrow();
  });
});

describe('formatTimeRange', () => {
  it('round-trips a standard range', () => {
    expect(formatTimeRange(parseTimeRange('[0:0_10:0)'))).toBe('[0:0_10:0)');
  });

  it('round-trips inclusivity and nanoseconds', () => {
    const input = '(5:500000000_6:0]';
    expect(formatTimeRange(parseTimeRange(input))).toBe(input);
  });
});

describe('toKey', () => {
  it('zero-pads to a fixed width', () => {
    const key = toKey(10n * NS);
    expect(key).toHaveLength(KEY_WIDTH);
    expect(key).toBe('00000000010000000000');
  });

  it('preserves numeric order lexicographically', () => {
    expect(toKey(1n) < toKey(2n)).toBe(true);
    expect(toKey(9n) < toKey(10n)).toBe(true);
    expect(toKey(2n * NS) < toKey(10n * NS)).toBe(true);
  });

  it('throws when a timestamp exceeds the key width', () => {
    expect(() => toKey(10n ** BigInt(KEY_WIDTH))).toThrow();
  });
});

describe('segmentKeys', () => {
  it('encodes both bounds of a concrete range', () => {
    expect(segmentKeys('[0:0_10:0)')).toEqual({
      tsStart: toKey(0n),
      tsEnd: toKey(10n * NS)
    });
  });

  it('rejects an unbounded range', () => {
    expect(() => segmentKeys('[0:0_')).toThrow();
    expect(() => segmentKeys('_10:0)')).toThrow();
  });
});

describe('overlapBounds', () => {
  it('maps a standard half-open query to keys with a strict start operator', () => {
    // '[5:0_15:0)' has an exclusive end, so ts_start must be < 15:0.
    expect(overlapBounds('[5:0_15:0)')).toEqual({
      startBelow: toKey(15n * NS),
      startOp: '$lt',
      endAbove: toKey(5n * NS),
      endOp: '$gt'
    });
  });

  it('uses $lte on the start constraint when the query end is inclusive', () => {
    // '[5:0_15:0]' has an inclusive end, so a segment beginning exactly at
    // 15:0 must still match: ts_start <= 15:0.
    const bounds = overlapBounds('[5:0_15:0]');
    expect(bounds.startBelow).toBe(toKey(15n * NS));
    expect(bounds.startOp).toBe('$lte');
  });

  it('treats an instant query [t] as ts_start <= t and ts_end > t', () => {
    // Spec example: '[10:0]' is an instantaneous timerange (start == end,
    // both inclusive). A segment starting exactly at 10:0 must match.
    const bounds = overlapBounds('[10:0]');
    expect(bounds.startBelow).toBe(toKey(10n * NS));
    expect(bounds.startOp).toBe('$lte');
    expect(bounds.endAbove).toBe(toKey(10n * NS));
    expect(bounds.endOp).toBe('$gt');
  });

  it('keeps the ts_end constraint strict regardless of query start inclusivity', () => {
    // ts_end is exclusive in storage, so a segment ending exactly at the
    // query start never overlaps. Operator is $gt for inclusive and
    // exclusive query starts alike.
    expect(overlapBounds('[5:0_15:0)').endOp).toBe('$gt');
    expect(overlapBounds('(5:0_15:0)').endOp).toBe('$gt');
  });

  it('leaves the missing side null for open queries', () => {
    expect(overlapBounds('[5:0_').startBelow).toBeNull();
    expect(overlapBounds('_15:0)').endAbove).toBeNull();
  });

  it('imposes no constraint for an eternal query', () => {
    const bounds = overlapBounds('_');
    expect(bounds.startBelow).toBeNull();
    expect(bounds.endAbove).toBeNull();
  });
});
