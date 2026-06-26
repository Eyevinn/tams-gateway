// Reclaim a Source that no surviving Flow references.
//
// A Source in this gateway is created/updated only as a side effect of a Flow
// PUT (putFlow inserts it from the Flow's source_id); there is no POST/PUT
// /sources endpoint, so a Source exists purely as the projection of the Flows
// that reference it. The symmetric completion of that lifecycle is that once
// the last Flow referencing a source_id is deleted, the Source is removed and a
// sources/deleted event is emitted (both declared by the TAMS spec the gateway
// implements). Without this, deleted Flows leave their Sources behind forever:
// orphaned Source docs accumulate with no API path to remove them.
//
// This handles both leaf and multi-essence Sources: a multi-essence Source is
// the source_id of a grouping Flow (whose source_collection is derived from its
// flow_collection in putFlow), so the same "is any Flow still referencing this
// source_id" check reclaims it when its grouping Flow is the last one gone,
// while member Sources survive as long as their member Flows do.

import { flowsClient, sourcesClient } from '../../db/client';
import notifyWebhooks from './notifyWebhooks';
import withCouchRetry from '../../db/withCouchRetry';

// Reclaim the Source if no remaining Flow references it. Call AFTER the deleted
// Flow's own doc has been destroyed, so the just-deleted Flow does not count as
// a surviving reference. Idempotent on resume: if the Source is already gone
// (a previous interrupted run reached this point) it is a no-op and no event is
// re-emitted. Best-effort like reclaimObjects: a still-referenced Source is
// simply left in place.
export const reclaimSourceIfOrphaned = async (
  sourceId: string
): Promise<void> => {
  if (!sourceId) return;

  // Any surviving Flow still using this Source? Backed by FLOWS_SOURCE_INDEX.
  // limit 1: we only need to know whether at least one reference remains.
  const referencing = await withCouchRetry(() =>
    flowsClient.find({
      selector: { source_id: sourceId },
      fields: ['_id'],
      limit: 1
    })
  );
  if (referencing.docs.length > 0) return;

  // Orphaned: remove the Source doc. Treat 404 and 409 as benign no-ops without
  // re-emitting the event: 404 means a previous run already deleted it (resume).
  // 409 means the _rev moved under us, i.e. a concurrent writer touched the doc
  // (a competing reclaim, or a flow PUT that just re-created/updated the Source,
  // in which case it is no longer orphaned). Both are the safe direction, leave
  // the Source to whoever won. Under the single-pod worker model these cannot
  // occur (the worker is serial); this guards the documented multi-pod follow-up.
  try {
    const source = await withCouchRetry(() => sourcesClient.get(sourceId));
    await withCouchRetry(() => sourcesClient.destroy(source._id, source._rev));
  } catch (e: unknown) {
    const status = (e as { statusCode?: number }).statusCode;
    if (status === 404 || status === 409) return;
    throw e;
  }

  await notifyWebhooks(
    'sources/deleted',
    { source_id: sourceId },
    { sourceId }
  );
};

export default reclaimSourceIfOrphaned;
