import { DocumentScope } from 'nano';

// Fetch a document by id, returning undefined for a missing document (404)
// instead of throwing. Any other error (network, auth, server) still
// propagates. Collapses the get-then-handle-404 dance repeated across handlers
// that upsert documents.
const getOrUndefined = async <D>(db: DocumentScope<D>, id: string) => {
  try {
    return await db.get(id);
  } catch (e) {
    if ((e as { statusCode?: number }).statusCode === 404) {
      return undefined;
    }
    throw e;
  }
};

export default getOrUndefined;
