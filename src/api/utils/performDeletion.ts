// Shared, per-batch flow/segment deletion used by the background deletion
// worker (deletionWorker.ts). Given a persisted Flow Delete Request, it deletes
// the matching segments in batches and reclaims each batch's now-unreferenced
// media objects WITHIN the same batch iteration.
//
// Why per-batch reclaim (the orphan-bug fix): the previous handlers deleted
// every segment doc first and reclaimed S3 objects only once at the very end. A
// flow with tens of thousands of segments takes longer than the OSC ingress
// (~50-60s) request timeout, so the synchronous DELETE was aborted before
// reclaim ran. Across client retries the segment docs all got deleted but the
// reclaim never completed, and a retry then found zero segments left (so
// reclaimed nothing): every S3 object was orphaned permanently. Verified live:
// deleting a flow with 43k segments returned 204 but left all 43k objects in the
// bucket.
//
// Fix: each batch deletes its segment docs and then reclaims that batch's
// objects before the next batch is fetched. An interruption (pod restart, crash)
// only loses the in-flight batch; every completed batch has already reclaimed
// its objects. On resume the worker re-runs this function and the already-gone
// segments simply do not reappear. We delete-then-reclaim within the batch
// (never reclaim-then-delete) because reclaimUnreferencedObjects treats any
// surviving segment as a live reference, so the batch's own segments must be
// gone before its objects are checked.

import { MangoSelector } from 'nano';
import { segmentsClient, flowsClient } from '../../db/client';
import { DeletionRequestDoc } from '../../db/schemas/deletion-requests/DeletionRequest';
import reclaimUnreferencedObjects from './reclaimObjects';
import reclaimSourceIfOrphaned from './reclaimSource';
import notifyWebhooks from './notifyWebhooks';
import withCouchRetry from '../../db/withCouchRetry';
import { parseTimeRange, toKey, formatTimeRange } from './timerange';

// Segments deleted (and their objects reclaimed) per batch. A Mango find with
// no explicit limit returns only CouchDB's default page, so the delete loops
// until the selector matches nothing; an explicit limit keeps each batch bounded.
const BATCH = 1000;

// Build the segment selector for a delete request: always scoped to the flow,
// narrowed by the request's timerange (containment: the segment must START at or
// after the range start and its exclusive END at or before the range end) and,
// when set, the object_id filter.
const buildSelector = (doc: DeletionRequestDoc): MangoSelector => {
  const selector: MangoSelector = { flow_id: doc.flow_id };
  const range = parseTimeRange(doc.timerange_to_delete);
  if (range.start !== null) {
    selector.ts_start = {
      [range.startInclusive ? '$gte' : '$gt']: toKey(range.start)
    };
  }
  if (range.end !== null) {
    selector.ts_end = { $lte: toKey(range.end) };
  }
  if (doc.object_id_filter) {
    selector.object_id = doc.object_id_filter;
  }
  return selector;
};

export interface DeletionResult {
  deleted: number;
  // The actual deleted span (intersection of the deleted segments), or null if
  // nothing was deleted. Used as the event timerange, which the spec requires to
  // intersect a deleted segment.
  deletedRange: string | null;
}

// Run the request to completion: per-batch delete + reclaim, then (when
// delete_flow) destroy the flow doc and emit the matching event. Throws on a
// non-transient failure so the worker can mark the request `error`; transient
// CouchDB 503/429 are retried inside withCouchRetry.
export const performDeletion = async (
  doc: DeletionRequestDoc
): Promise<DeletionResult> => {
  const selector = buildSelector(doc);

  let deleted = 0;
  let firstStart: bigint | null = null;
  let lastEnd: bigint | null = null;

  for (;;) {
    const batch = await withCouchRetry(() =>
      segmentsClient.find({
        selector,
        fields: ['_id', '_rev', 'object_id', 'ts_start', 'ts_end'],
        limit: BATCH
      })
    );
    if (batch.docs.length === 0) break;

    // 1) Delete this batch's segment docs.
    await withCouchRetry(() =>
      segmentsClient.bulk({
        docs: batch.docs.map((d) => ({
          _id: d._id,
          _rev: d._rev,
          _deleted: true
        }))
      })
    );

    // 2) Reclaim THIS batch's now-unreferenced objects, before fetching the next
    //    batch. The batch's segments are already deleted (step 1), so they no
    //    longer count as references. Best-effort: a failed object delete is
    //    logged inside reclaimUnreferencedObjects, not thrown.
    const batchObjectIds: string[] = [];
    for (const d of batch.docs) {
      if (d.object_id) batchObjectIds.push(d.object_id);
      const start = BigInt(d.ts_start);
      const end = BigInt(d.ts_end);
      if (firstStart === null || start < firstStart) firstStart = start;
      if (lastEnd === null || end > lastEnd) lastEnd = end;
    }
    await reclaimUnreferencedObjects(batchObjectIds);

    deleted += batch.docs.length;
    if (batch.docs.length < BATCH) break;
  }

  const deletedRange =
    deleted > 0 && firstStart !== null && lastEnd !== null
      ? formatTimeRange({
          start: firstStart,
          end: lastEnd,
          startInclusive: true,
          endInclusive: false
        })
      : null;

  if (doc.delete_flow) {
    // All of the flow's segments and their objects are now gone, so it is safe
    // to remove the flow doc and announce the deletion. The doc may already be
    // gone if a previous (interrupted) run reached this point; treat 404 as
    // success so resume is idempotent.
    try {
      const flow = await withCouchRetry(() => flowsClient.get(doc.flow_id));
      await withCouchRetry(() => flowsClient.destroy(flow._id, flow._rev));
    } catch (e: unknown) {
      if ((e as { statusCode?: number }).statusCode !== 404) throw e;
    }
    await notifyWebhooks(
      'flows/deleted',
      { flow_id: doc.flow_id },
      { flowId: doc.flow_id }
    );
    // The flow is gone: if it was the last flow referencing its Source, reclaim
    // the now-orphaned Source and emit sources/deleted. source_id was captured
    // on the request at creation time (deleteFlow) so this works even when the
    // flow doc was already deleted by a previous interrupted run.
    if (doc.source_id) {
      await reclaimSourceIfOrphaned(doc.source_id);
    }
  } else if (deletedRange !== null) {
    // Segment-only deletion: the event timerange MUST intersect a deleted
    // segment, so only emit when something was actually deleted.
    await notifyWebhooks(
      'flows/segments_deleted',
      { flow_id: doc.flow_id, timerange: deletedRange },
      { flowId: doc.flow_id }
    );
  }

  return { deleted, deletedRange };
};

export default performDeletion;
