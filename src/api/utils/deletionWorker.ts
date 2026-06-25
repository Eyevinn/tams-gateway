// In-process background worker that executes Flow Delete Requests.
//
// DELETE /flows/{id} and DELETE /flows/{id}/segments persist a request with
// status `created` and return 202 immediately, so the client is never bound by
// the OSC ingress (~50-60s) request timeout for a large deletion. This worker,
// started from server.ts at startup and stopped on shutdown, claims pending
// requests and runs the per-batch delete + reclaim (performDeletion) to
// completion server-side, moving status created -> started -> done (or ->
// error).
//
// Resume: on startup, and on every poll, the worker scans for non-terminal
// requests (`created` or `started`). A `started` request left behind by a
// crashed or restarted pod is simply re-claimed and re-run; performDeletion is
// idempotent (it re-finds whatever segments still remain), so resuming a
// partially-done request finishes it without double-deleting.
//
// Concurrency: this assumes a SINGLE gateway pod. There is no cross-pod lease,
// so two pods could claim the same request and both run it. performDeletion is
// idempotent enough that this is safe-ish (re-deletes nothing, bulk delete of an
// already-deleted doc just 404/409s per doc), but it is wasteful and the status
// transitions could race. Multi-pod claim/lease (e.g. a lease token + expiry, or
// a single-writer queue) is a documented follow-up. See the PR description.

import { deletionRequestsClient } from '../../db/client';
import { DeletionRequestDoc } from '../../db/schemas/deletion-requests/DeletionRequest';
import performDeletion from './performDeletion';
import withCouchRetry from '../../db/withCouchRetry';
import Logger from '../../utils/Logger';

// How often to poll for pending requests when idle.
const POLL_INTERVAL_MS = Number(process.env.DELETION_WORKER_POLL_MS) || 2000;

let timer: NodeJS.Timeout | null = null;
let running = false; // a process() pass is in flight
let stopped = false; // stop() requested; do not schedule further passes

// Fetch the oldest non-terminal request to work on. Ordered by creation time so
// requests are processed roughly FIFO. Backed by DELETION_REQUESTS_STATUS_INDEX.
const findPending = async (): Promise<DeletionRequestDoc | undefined> => {
  const res = await withCouchRetry(() =>
    deletionRequestsClient.find({
      selector: { status: { $in: ['created', 'started'] } },
      limit: 1
    })
  );
  return res.docs[0] as DeletionRequestDoc | undefined;
};

// Claim a request by moving it to `started`. Uses the doc's _rev so a concurrent
// claim loses with a 409 (returned as claimed=false) rather than both running.
const claim = async (
  doc: DeletionRequestDoc
): Promise<DeletionRequestDoc | undefined> => {
  const updated = new Date().toISOString();
  try {
    const res = await deletionRequestsClient.insert({
      ...doc,
      status: 'started',
      updated
    });
    return { ...doc, status: 'started', updated, _rev: res.rev };
  } catch (e: unknown) {
    if ((e as { statusCode?: number }).statusCode === 409) {
      // Lost the claim (or the doc moved on); let the next poll re-evaluate.
      return undefined;
    }
    throw e;
  }
};

const markDone = async (doc: DeletionRequestDoc): Promise<void> => {
  const updated = new Date().toISOString();
  await withCouchRetry(() =>
    deletionRequestsClient.insert({ ...doc, status: 'done', updated })
  );
};

const markError = async (
  doc: DeletionRequestDoc,
  err: unknown
): Promise<void> => {
  const now = new Date().toISOString();
  const summary = err instanceof Error ? err.message : String(err);
  // Re-fetch the latest _rev: the claim wrote a new revision, and we want this
  // write to win even if a transient retry already bumped it.
  try {
    const latest = (await withCouchRetry(() =>
      deletionRequestsClient.get(doc.id)
    )) as DeletionRequestDoc;
    await withCouchRetry(() =>
      deletionRequestsClient.insert({
        ...latest,
        status: 'error',
        updated: now,
        error: { type: 'about:blank', summary, time: now }
      })
    );
  } catch (writeErr) {
    // Never let a bookkeeping failure crash the worker loop.
    Logger.red(
      `Deletion worker: failed to record error for request ${doc.id}: ${
        writeErr instanceof Error ? writeErr.message : String(writeErr)
      }`
    );
  }
};

// Process at most one pending request per pass. Returns true if it did work, so
// the caller can immediately poll again (drain the backlog) instead of waiting a
// full poll interval.
const processOne = async (): Promise<boolean> => {
  const pending = await findPending();
  if (!pending) return false;

  const claimed = await claim(pending);
  if (!claimed) return true; // someone else took it; keep draining

  try {
    await performDeletion(claimed);
    // markDone re-reads not needed: claimed carries the post-claim _rev and
    // performDeletion does not touch the request doc.
    await markDone(claimed);
    Logger.black(`Deletion worker: completed request ${claimed.id}`);
  } catch (err) {
    Logger.red(
      `Deletion worker: request ${claimed.id} failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    await markError(claimed, err);
  }
  return true;
};

// One scheduler pass: drain as many pending requests as exist, then reschedule.
const tick = async (): Promise<void> => {
  if (running || stopped) return;
  running = true;
  try {
    // Drain the backlog so a burst of requests (or a startup resume of several
    // non-terminal requests) is cleared without waiting a poll interval between
    // each. A thrown error here is unexpected (processOne catches per-request
    // failures itself); log and let the next scheduled tick retry.
    while (!stopped && (await processOne())) {
      /* keep draining */
    }
  } catch (err) {
    Logger.red(
      `Deletion worker: poll failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  } finally {
    running = false;
    if (!stopped) {
      timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    }
  }
};

// Start the worker. Idempotent. Runs an immediate pass (which resumes any
// non-terminal requests left by a previous process) and then polls on an
// interval. The status scan is backed by DELETION_REQUESTS_STATUS_INDEX, created
// idempotently in initDatabases (db/client.ts).
export const startDeletionWorker = (): void => {
  stopped = false;
  if (timer) return;
  Logger.black('Deletion worker: started');
  void tick();
};

// Stop the worker so the process can exit cleanly. Cancels the next scheduled
// pass; an in-flight pass finishes (it checks `stopped` between requests).
export const stopDeletionWorker = (): void => {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
};

// Exported for tests: run a single drain pass synchronously.
export const __processAll = async (): Promise<void> => {
  while (await processOne()) {
    /* drain */
  }
};
