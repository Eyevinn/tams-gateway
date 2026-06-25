// Reclaim media objects that no surviving Flow Segment references.
//
// A media object can be referenced by Flow Segments in more than one Flow (see
// the TAMS Object schema's `referenced_by_flows`). After deleting some segments,
// only the objects that no remaining (non-deleted) segment references may be
// removed from the store. Shared by deleteFlow and deleteSegments.

import { segmentsClient } from '../../db/client';
import deleteS3Objects from './deleteS3Objects';
import Logger from '../../utils/Logger';
import withCouchRetry from '../../db/withCouchRetry';

// How many object_ids to check per $in query. One round resolves the whole
// batch when none are still referenced (the common case once a flow's own
// segments are deleted); otherwise a few rounds as referenced ids drop out.
const RECLAIM_BATCH = 1000;

const findUnreferencedObjects = async (
  objectIds: string[]
): Promise<string[]> => {
  const unreferenced: string[] = [];
  // Batched reference check (one query for up to RECLAIM_BATCH objects instead
  // of one per object). For each batch we keep a `remaining` set of candidates
  // and ask for ANY surviving segment that references one of them ($in, backed
  // by SEGMENTS_OBJECT_INDEX; deleted segments are already excluded from Mango
  // results). Every returned segment proves its object_id is still referenced,
  // so we drop that id from `remaining`.
  //
  // Safety invariant (no live object is ever wrongly reclaimed): an object_id is
  // declared unreferenced ONLY when a query whose $in still INCLUDED it returns
  // zero docs, i.e. no segment references any id in the set. A page `limit` can
  // therefore never cause a referenced object to be reclaimed; in the worst case
  // a crowded result just costs another round. Termination: a non-empty result
  // removes at least one id from `remaining`, so it strictly shrinks.
  for (let i = 0; i < objectIds.length; i += RECLAIM_BATCH) {
    const remaining = new Set(objectIds.slice(i, i + RECLAIM_BATCH));
    while (remaining.size > 0) {
      const ids = [...remaining];
      const referencing = await withCouchRetry(() =>
        segmentsClient.find({
          selector: { object_id: { $in: ids } },
          fields: ['object_id'],
          limit: ids.length
        })
      );
      if (referencing.docs.length === 0) {
        // No surviving segment references any remaining id: all reclaimable.
        for (const id of remaining) unreferenced.push(id);
        break;
      }
      for (const doc of referencing.docs) {
        const objectId = (doc as { object_id?: string }).object_id;
        if (objectId) remaining.delete(objectId);
      }
    }
  }
  return unreferenced;
};

// Delete the subset of the given object_ids that no remaining segment
// references. Storage reclaim is best-effort: the segment docs are already gone,
// so a failed object delete is logged (the leak is visible and recoverable)
// rather than failing the request. Call after the segment docs are deleted so
// the just-deleted segments do not count as references.
export const reclaimUnreferencedObjects = async (
  objectIds: string[]
): Promise<void> => {
  const candidates = [...new Set(objectIds.filter(Boolean))];
  if (candidates.length === 0) return;
  const unreferenced = await findUnreferencedObjects(candidates);
  if (unreferenced.length === 0) return;
  const { errors } = await deleteS3Objects(unreferenced);
  for (const error of errors) {
    Logger.red(
      `Failed to delete media object ${error.object_id}: ${error.message}`
    );
  }
};

export default reclaimUnreferencedObjects;
