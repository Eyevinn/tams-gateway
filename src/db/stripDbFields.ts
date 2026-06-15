// Remove CouchDB bookkeeping fields (_id/_rev) so a stored document can be
// returned to clients as the spec object it represents. Returning the document
// verbatim (rather than re-serialising it through a narrower response schema)
// preserves every spec field the client stored, so the response validates
// against the canonical TAMS schemas (flow.json, source.json).
const stripDbFields = <T extends object>(doc: T): Omit<T, '_id' | '_rev'> => {
  const copy = { ...doc } as Record<string, unknown>;
  delete copy._id;
  delete copy._rev;
  return copy as Omit<T, '_id' | '_rev'>;
};

export default stripDbFields;
