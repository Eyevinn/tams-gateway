// TAMS time model.
//
// A TAMS timerange is a string "[<start>_<end>)" where each timestamp is
// "<seconds>:<nanoseconds>" counted from the epoch (TAI). The brackets mark
// inclusivity: '[' / ']' inclusive, '(' / ')' exclusive. Default is start
// inclusive, end exclusive. Ranges may be open ("[<start>_", "_<end>)", "_")
// and a bare "<sec>:<ns>" denotes the single instant [t,t].
//
// Internally a timestamp is the total number of nanoseconds as a BigInt so that
// arithmetic is exact (a nanosecond count overflows JS Number precision). For
// storage and indexing we encode each bound as a fixed-width zero-padded decimal
// string so CouchDB/Mango lexicographic range queries match numeric order.
//
// Note: negative (pre-epoch) timestamps are not supported; media timestamps are
// positive in practice and zero-padding only preserves order for non-negatives.

const NS_PER_SEC = 1_000_000_000n;

// 20 digits covers nanoseconds well beyond any realistic media timestamp.
export const KEY_WIDTH = 20;
export const MIN_KEY = '0'.repeat(KEY_WIDTH);
export const MAX_KEY = '9'.repeat(KEY_WIDTH);

export interface TimeRange {
  start: bigint | null; // null = open (negative eternity)
  end: bigint | null; // null = open (positive eternity)
  startInclusive: boolean;
  endInclusive: boolean;
}

// Encode a nanosecond count as a fixed-width, sortable key.
export const toKey = (ns: bigint): string => {
  const s = ns.toString();
  if (s.length > KEY_WIDTH) {
    throw new Error(`Timestamp ${s} exceeds ${KEY_WIDTH}-digit key width`);
  }
  return s.padStart(KEY_WIDTH, '0');
};

const parseTimestamp = (value: string): bigint => {
  const [sec, ns = '0'] = value.split(':');
  if (!/^\d+$/.test(sec) || !/^\d+$/.test(ns)) {
    throw new Error(`Invalid timestamp "${value}"`);
  }
  return BigInt(sec) * NS_PER_SEC + BigInt(ns);
};

const formatTimestamp = (ns: bigint): string =>
  `${ns / NS_PER_SEC}:${ns % NS_PER_SEC}`;

export const parseTimeRange = (input: string): TimeRange => {
  const value = input.trim();
  if (value === '') {
    throw new Error('Empty timerange');
  }

  // Single timestamp (no '_' separator) => instantaneous timerange [t,t].
  // The spec permits this with optional inclusive markers ("10:0", "[10:0]")
  // and forbids exclusive markers on an instant. We strip any surrounding
  // inclusive markers and treat the lone timestamp as the closed range
  // [t,t]; "[10:0]" is equivalent to "[10:0_10:0]".
  if (!value.includes('_')) {
    const bare = value.replace(/^\[/, '').replace(/\]$/, '');
    const t = parseTimestamp(bare);
    return { start: t, end: t, startInclusive: true, endInclusive: true };
  }

  const startInclusive = value[0] !== '(';
  const endInclusive = value[value.length - 1] === ']';
  const inner = value.replace(/^[[(]/, '').replace(/[\])]$/, '');
  const [startStr, endStr] = inner.split('_');

  return {
    start: startStr ? parseTimestamp(startStr) : null,
    end: endStr ? parseTimestamp(endStr) : null,
    startInclusive,
    endInclusive
  };
};

export const formatTimeRange = (range: TimeRange): string => {
  const open = range.startInclusive ? '[' : '(';
  const close = range.endInclusive ? ']' : ')';
  const start = range.start === null ? '' : formatTimestamp(range.start);
  const end = range.end === null ? '' : formatTimestamp(range.end);
  return `${open}${start}_${end}${close}`;
};

// Storage keys for a concrete segment timerange (both bounds required).
export const segmentKeys = (
  timerange: string
): { tsStart: string; tsEnd: string } => {
  const range = parseTimeRange(timerange);
  if (range.start === null || range.end === null) {
    throw new Error(`Segment timerange "${timerange}" must be bounded`);
  }
  return { tsStart: toKey(range.start), tsEnd: toKey(range.end) };
};

// Query-side overlap bounds for filtering segments against a requested range.
//
// Segments are stored as half-open ranges [ts_start, ts_end): ts_start is
// inclusive (the first sample) and ts_end is exclusive (one past the last
// sample). A stored segment overlaps a query range Q when:
//
//   (A) ts_start is at or before Q.end, AND
//   (B) ts_end is strictly after Q.start.
//
// The operator on side (A) depends on Q's END inclusivity, because the
// boundary point ts_start == Q.end is shared only when Q.end is inclusive
// (']' => $lte, ')' => $lt). Side (B) is always strict ($gt): ts_end is
// exclusive, so a segment ending exactly at Q.start (ts_end == Q.start)
// covers no point in Q regardless of whether Q.start is inclusive. This is
// what makes an instant query "[t]" (start == end == t, both inclusive)
// match a segment starting exactly at t: ts_start <= t AND ts_end > t.
//
// `startOp` constrains the segment's ts_start; `endOp` constrains ts_end.
// A null bound means that side of the query is open (eternity) and imposes
// no constraint.
export interface OverlapBounds {
  startBelow: string | null; // compare against segment ts_start
  startOp: '$lt' | '$lte'; // operator for the ts_start constraint
  endAbove: string | null; // compare against segment ts_end
  endOp: '$gt'; // operator for the ts_end constraint (always strict)
}

export const overlapBounds = (timerange: string): OverlapBounds => {
  const range = parseTimeRange(timerange);
  return {
    startBelow: range.end === null ? null : toKey(range.end),
    startOp: range.endInclusive ? '$lte' : '$lt',
    endAbove: range.start === null ? null : toKey(range.start),
    endOp: '$gt'
  };
};
