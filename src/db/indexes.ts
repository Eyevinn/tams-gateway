// Mango index descriptors that query code needs by name. They live apart from
// the database client so that code (and tests) that only need a name do not have
// to import, or mock, the client.

// Mango index backing the start of a timerange window: it finds the first
// segment of a flow that ends after the window start by [flow_id, ts_end]. See
// findWindowStart for why that lookup is needed.
export const SEGMENTS_TS_END_INDEX = {
  ddoc: 'segments-ts-end-index',
  name: 'flow-ts-end'
};
