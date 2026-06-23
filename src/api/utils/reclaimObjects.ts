// Reclaim media objects that no surviving Flow Segment references.
//
// A media object can be referenced by Flow Segments in more than one Flow (see
// the TAMS Object schema's `referenced_by_flows`). After deleting some segments,
// only the objects that no remaining (non-deleted) segment references may be
// removed from the store. Shared by deleteFlow and deleteSegments.

import { segmentsClient } from '../../db/client';
import deleteS3Objects from './deleteS3Objects';
import Logger from '../../utils/Logger';

const findUnreferencedObjects = async (
  objectIds: string[]
): Promise<string[]> => {
  const unreferenced: string[] = [];
  for (const objectId of objectIds) {
    // Deleted segments are already excluded from Mango results, so any hit here
    // is a live reference (in this or another flow) and the object must stay.
    const stillReferenced = await segmentsClient.find({
      selector: { object_id: objectId },
      fields: ['_id'],
      limit: 1
    });
    if (stillReferenced.docs.length === 0) {
      unreferenced.push(objectId);
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
