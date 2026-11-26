import { segmentsClient } from '../../db/client';
import { SEGMENTS_TS_END_INDEX } from '../../db/indexes';
import { OverlapBounds } from './timerange';

// Where the segments overlapping a timerange begin in a flow.
//
// `empty` means no segment of the flow ends after the window start, so nothing
// can overlap and the main query can be skipped. Otherwise `lowerTsStart` is
// the smallest ts_start that can belong to an overlapping segment, or null when
// the window has no start (an open or eternity start needs no lower bound).
export type WindowStart =
  | { empty: true }
  | { empty: false; lowerTsStart: string | null };

// A stored segment [ts_start, ts_end) overlaps a window when ts_start is before
// the window end AND ts_end is after the window start. The segments index is on
// [flow_id, ts_start], so it can only bound the first condition: the second one
// is checked document by document, and CouchDB reads every segment of the flow
// from the beginning up to the window end. The cost of listing a short window
// then grows with the age of the flow instead of with the window.
//
// This finds the lower bound the main query is missing. Segments of one flow do
// not overlap each other (the TAMS API requires it), so their order by ts_end is
// the same as by ts_start, and the first segment that ends after the window
// start is also the first that can overlap it. Its ts_start is a lower bound the
// [flow_id, ts_start] index can use, so the main query reads only the window.
// The lookup itself reads one entry of the [flow_id, ts_end] index.
//
// If a flow holds overlapping segments anyway (which the TAMS API leaves
// undefined) a segment that starts before the first one found but overlaps the
// window can be missed.
export const findWindowStart = async (
  flowId: string,
  bounds: OverlapBounds
): Promise<WindowStart> => {
  if (bounds.endAbove === null) {
    return { empty: false, lowerTsStart: null };
  }
  const first = await segmentsClient.find({
    selector: { flow_id: flowId, ts_end: { [bounds.endOp]: bounds.endAbove } },
    sort: [{ flow_id: 'asc' }, { ts_end: 'asc' }],
    fields: ['ts_start'],
    use_index: [SEGMENTS_TS_END_INDEX.ddoc, SEGMENTS_TS_END_INDEX.name],
    limit: 1
  });
  const tsStart = first.docs[0]?.ts_start;
  return tsStart === undefined
    ? { empty: true }
    : { empty: false, lowerTsStart: tsStart };
};

// Merge a lower bound on ts_start into the selector's existing ts_start
// condition, keeping the stricter of it and any bound already set (the paging
// cursor of an ascending page is also a `$gte`, and always at or after it).
export const withLowerTsStart = (
  tsStart: Record<string, string> | undefined,
  lowerTsStart: string
): Record<string, string> => {
  const current = tsStart ?? {};
  return {
    ...current,
    $gte:
      current.$gte !== undefined && current.$gte > lowerTsStart
        ? current.$gte
        : lowerTsStart
  };
};
