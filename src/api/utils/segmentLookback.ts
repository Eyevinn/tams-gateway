import { segmentMetaClient, segmentsClient } from '../../db/client';
import getOrUndefined from '../../db/getOrUndefined';
import withCouchRetry from '../../db/withCouchRetry';
import Logger from '../../utils/Logger';
import { toKey } from './timerange';

// A segment overlapping a window [Q.start, Q.end) has ts_end > Q.start, so if no
// segment of the flow lasts longer than `max`, its ts_start is > Q.start - max.
// That is a lower bound on ts_start the [flow_id, ts_start] index can use;
// without it the index read starts at the beginning of the flow.
//
// `max` lives in its own document per flow (database segment_meta, id = flow
// id), written only by segment registration, so it never conflicts with writes
// to the flow document, and concurrent registrations are serialised by
// CouchDB's revision check (a 409 is retried). Whenever
// it exists it covers every stored segment: registration raises it before
// writing a longer segment, and it is never lowered (deleting segments leaves a
// larger, merely conservative value). Deleting the flow removes it.

const maxDocId = (flowId: string) => flowId;

const parseNs = (raw: unknown): bigint | undefined => {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return undefined;
  return BigInt(raw);
};

// The ts_start key below which no segment can overlap a window starting at
// `windowStartKey` (the ts_end > bound of overlapBounds), or null when no bound
// applies: the window start is open, the flow has no recorded maximum yet, or
// the bound would be at or before the epoch (every key is already above it).
export const lookbackStartKey = (
  max: bigint | undefined,
  windowStartKey: string | null
): string | null => {
  if (windowStartKey === null || max === undefined) return null;
  const lower = BigInt(windowStartKey) - max;
  return lower > 0n ? toKey(lower) : null;
};

// The flow's recorded maximum segment duration, or undefined when none is
// recorded (the caller then runs the unbounded query).
export const getMaxSegmentDuration = async (
  flowId: string
): Promise<bigint | undefined> => {
  const doc = await withCouchRetry(() =>
    getOrUndefined(segmentMetaClient, maxDocId(flowId))
  );
  return parseNs(doc?.max_ns);
};

// Remove a flow's recorded maximum. Best-effort and idempotent: a record left
// behind is only a larger, conservative bound, and the caller has already
// destroyed the flow, so a failure here must not fail the deletion. A 409 means
// a registration raised the record meanwhile; re-read and try again.
export const deleteMaxSegmentDuration = async (flowId: string) => {
  for (let attempt = 0; attempt < DELETE_ATTEMPTS; attempt++) {
    try {
      const doc = await withCouchRetry(() =>
        segmentMetaClient.get(maxDocId(flowId))
      );
      await withCouchRetry(() => segmentMetaClient.destroy(doc._id, doc._rev));
      return;
    } catch (e: unknown) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404) return;
      if (status !== 409) {
        Logger.red(
          `Could not remove the recorded segment duration of flow "${flowId}": ${
            e instanceof Error ? e.message : String(e)
          }`
        );
        return;
      }
    }
  }
};

const DELETE_ATTEMPTS = 5;
const SCAN_PAGE = 1000;
const MAX_ATTEMPTS = 20;

// The longest duration among a flow's currently stored segments, found with a
// paged scan. Only used the first time a flow with no recorded maximum receives
// a segment (flows that predate the record). Concurrent first registrations for
// the same flow share one scan.
const scanMaxStoredDuration = async (flowId: string): Promise<bigint> => {
  let max = 0n;
  let bookmark: string | undefined;
  for (;;) {
    const page = await withCouchRetry(() =>
      segmentsClient.find({
        selector: { flow_id: flowId },
        // The sort makes Mango use the [flow_id, ts_start] index; without it
        // the lookup falls back to scanning every segment of every flow.
        sort: [{ flow_id: 'asc' }, { ts_start: 'asc' }],
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

const scans = new Map<string, Promise<bigint>>();
const scanOnce = (flowId: string): Promise<bigint> => {
  let scan = scans.get(flowId);
  if (scan === undefined) {
    scan = scanMaxStoredDuration(flowId).finally(() => scans.delete(flowId));
    scans.set(flowId, scan);
  }
  return scan;
};

// Raise the flow's recorded maximum to at least `batchMax`. Call it BEFORE
// writing the segments: a failure in between then leaves a too-large value
// (slower queries) instead of segments the bound would hide. The record is
// written only when the value rises. Only registrations write it, so a 409
// means another registration raised it: re-read and try again. Each retry
// follows another writer's success, and returns as soon as the value is high
// enough.
export const raiseMaxSegmentDuration = async (
  flowId: string,
  batchMax: bigint
): Promise<void> => {
  const id = maxDocId(flowId);
  let scanned: bigint | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const doc = await withCouchRetry(() =>
      getOrUndefined(segmentMetaClient, id)
    );
    const current = parseNs(doc?.max_ns);
    if (current === undefined && scanned === undefined) {
      scanned = await scanOnce(flowId);
    }

    let target = batchMax > 0n ? batchMax : 0n;
    if (current === undefined && scanned !== undefined && scanned > target) {
      target = scanned;
    }
    if (current !== undefined && current >= target) return;

    try {
      await withCouchRetry(() =>
        segmentMetaClient.insert({
          _id: id,
          ...(doc?._rev ? { _rev: doc._rev } : {}),
          max_ns: target.toString()
        })
      );
      return;
    } catch (e: unknown) {
      if ((e as { statusCode?: number }).statusCode !== 409) throw e;
      // Another registration wrote the record; re-read and try again.
    }
  }
  throw new Error(
    `Could not record the maximum segment duration for flow "${flowId}"`
  );
};
