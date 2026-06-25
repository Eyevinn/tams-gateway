// Retry a CouchDB operation on transient server-side failures.
//
// CouchDB returns 503 (and 429) when it is momentarily overloaded, e.g. while a
// Mango index is still building or under a burst of writes. A single 503 should
// not abort a multi-step operation such as a flow/segment delete: without a
// retry the delete fails part-way and can leave orphaned segments or media
// objects behind. Only these transient status codes are retried; everything
// else (404, 409 conflict, 4xx client errors) propagates immediately.

const TRANSIENT_STATUS = new Set([429, 503]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const withCouchRetry = async <T>(
  op: () => Promise<T>,
  retries = 4,
  baseDelayMs = 200
): Promise<T> => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (e: unknown) {
      const statusCode = (e as { statusCode?: number }).statusCode;
      if (
        attempt >= retries ||
        statusCode === undefined ||
        !TRANSIENT_STATUS.has(statusCode)
      ) {
        throw e;
      }
      // Exponential backoff: 200ms, 400ms, 800ms, 1600ms.
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
};

export default withCouchRetry;
