import { flowsClient, segmentsClient } from '../../db/client';
import getOrUndefined from '../../db/getOrUndefined';
import withCouchRetry from '../../db/withCouchRetry';
import { MAX_SEGMENT_DURATION_FIELD } from '../../db/schemas/flows/Flow';
import { toKey } from './timerange';

// A segment overlapping a window [Q.start, Q.end) has ts_end > Q.start, so if no
// segment of the flow lasts longer than `max`, its ts_start is > Q.start - max.
// That is a lower bound on ts_start the [flow_id, ts_start] index can use;
// without it the index read starts at the beginning of the flow.
//
// `max` is kept on the flow document. Whenever it is set it covers every stored
// segment: registration raises it before writing a longer segment, and it is
// never lowered (deleting segments leaves a larger, merely conservative value).

const parseNs = (raw: unknown): bigint | undefined => {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return undefined;
  return BigInt(raw);
};

// The ts_start key below which no segment can overlap a window starting at
// `windowStartKey` (the ts_end > bound of overlapBounds), or null when no bound
// applies: the window start is open, the flow has no recorded maximum yet, or
// the bound would be at or before the epoch (every key is already above it).
export const lookbackStartKey = (
  flow: object | undefined,
  windowStartKey: string | null
): string | null => {
  if (windowStartKey === null || flow === undefined) return null;
  const max = parseNs(
    (flow as unknown as Record<string, unknown>)[MAX_SEGMENT_DURATION_FIELD]
  );
  if (max === undefined) return null;
  const lower = BigInt(windowStartKey) - max;
  return lower > 0n ? toKey(lower) : null;
};

// Fetch a flow for the read side. A missing flow is not an error here: the
// caller simply runs the unbounded query, as before.
export const getFlowForLookback = (flowId: string) =>
  getOrUndefined(flowsClient, flowId);

const SCAN_PAGE = 1000;
const MAX_ATTEMPTS = 5;

// The longest duration among a flow's currently stored segments, found with a
// paged scan. Only used the first time a flow that has no recorded maximum
// receives a segment (flows that predate the field, or segments registered
// before the flow document existed).
const scanMaxStoredDuration = async (flowId: string): Promise<bigint> => {
  let max = 0n;
  let bookmark: string | undefined;
  for (;;) {
    const page = await withCouchRetry(() =>
      segmentsClient.find({
        selector: { flow_id: flowId },
        fields: ['ts_start', 'ts_end'],
        limit: SCAN_PAGE,
        ...(bookmark ? { bookmark } : {})
      })
    );
    for (const doc of page.docs) {
      const d = BigInt(doc.ts_end) - BigInt(doc.ts_start);
      if (d > max) max = d;
    }
    if (page.docs.length < SCAN_PAGE || !page.bookmark) return max;
    bookmark = page.bookmark;
  }
};

// Raise the flow's recorded maximum to at least `batchMax`. Call it BEFORE
// writing the segments: a failure in between then leaves a too-large value
// (slower queries) instead of segments the bound would hide. The flow document
// is written only when the value rises. A 409 is retried from a fresh read.
// Without a flow document nothing is recorded and queries stay unbounded.
export const raiseMaxSegmentDuration = async (
  flowId: string,
  batchMax: bigint
): Promise<void> => {
  let scanned: bigint | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const flow = await withCouchRetry(() =>
      getOrUndefined(flowsClient, flowId)
    );
    if (flow === undefined) return;

    const current = parseNs(
      (flow as unknown as Record<string, unknown>)[MAX_SEGMENT_DURATION_FIELD]
    );
    if (current === undefined && scanned === undefined) {
      scanned = await scanMaxStoredDuration(flowId);
    }

    let target = batchMax > 0n ? batchMax : 0n;
    if (current !== undefined && current > target) target = current;
    if (current === undefined && scanned !== undefined && scanned > target) {
      target = scanned;
    }
    if (current !== undefined && current >= target) return;

    try {
      await withCouchRetry(() =>
        flowsClient.insert({
          ...flow,
          [MAX_SEGMENT_DURATION_FIELD]: target.toString()
        })
      );
      return;
    } catch (e: unknown) {
      if ((e as { statusCode?: number }).statusCode !== 409) throw e;
      // Someone else updated the flow document; re-read and try again.
    }
  }
  throw new Error(
    `Could not record the maximum segment duration for flow "${flowId}"`
  );
};
