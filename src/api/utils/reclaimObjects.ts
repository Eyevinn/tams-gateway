// Reclaim media objects that no surviving Flow Segment references.
//
// A media object can be referenced by Flow Segments in more than one Flow (see
// the TAMS Object schema's `referenced_by_flows`). After deleting some segments,
// only the objects that no remaining (non-deleted) segment references may be
// removed from the store. Shared by deleteFlow and deleteSegments.

import { segmentsClient } from '../../db/client';
import deleteS3Objects from './deleteS3Objects';
import Logger from '../../utils/Logger';

// How many reference checks to run at once. Each check is a single indexed
// point-lookup (SEGMENTS_OBJECT_INDEX), so a bounded fan-out keeps wall-clock
// low for large deletions without overwhelming CouchDB with unbounded parallel
// requests.
const RECLAIM_CONCURRENCY = 16;

const findUnreferencedObjects = async (
  objectIds: string[]
): Promise<string[]> => {
  const unreferenced: string[] = [];
  // Each object_id is checked with its own limit-1 lookup (never a batched
  // $in): a batched query capped at a page limit could omit a still-referenced
  // object from the results and we would then wrongly reclaim a live object.
  // Run the checks in bounded-concurrency chunks rather than strictly serially.
  for (let i = 0; i < objectIds.length; i += RECLAIM_CONCURRENCY) {
    const chunk = objectIds.slice(i, i + RECLAIM_CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (objectId) => {
        // Deleted segments are already excluded from Mango results, so any hit
        // here is a live reference (in this or another flow) and the object
        // must stay. Backed by SEGMENTS_OBJECT_INDEX so this is an indexed
        // lookup, not a full scan.
        const stillReferenced = await segmentsClient.find({
          selector: { object_id: objectId },
          fields: ['_id'],
          limit: 1
        });
        return stillReferenced.docs.length === 0 ? objectId : null;
      })
    );
    for (const objectId of results) {
      if (objectId !== null) unreferenced.push(objectId);
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
