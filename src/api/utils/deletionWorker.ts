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

// Write a terminal status for the request, re-reading the latest revision first
// so the write wins even if the doc's _rev moved on during a long-running
// delete (performDeletion can run for minutes). Returns true if the terminal
// status was persisted, false if it could not be (caller must NOT keep retrying
// the same doc in a tight loop). Never throws.
const markTerminal = async (
  doc: DeletionRequestDoc,
  status: 'done' | 'error',
  err?: unknown
): Promise<boolean> => {
  const now = new Date().toISOString();
  try {
    const latest = (await withCouchRetry(() =>
      deletionRequestsClient.get(doc.id)
    )) as DeletionRequestDoc;
    // If another writer already moved this request to a terminal state, leave it
    // alone (do not clobber a `done` with a late `error`, or vice versa).
    if (latest.status === 'done' || latest.status === 'error') return true;
    const update: DeletionRequestDoc = { ...latest, status, updated: now };
    if (status === 'error') {
      const summary = err instanceof Error ? err.message : String(err);
      update.error = { type: 'about:blank', summary, time: now };
    }
    await withCouchRetry(() => deletionRequestsClient.insert(update));
    return true;
  } catch (writeErr) {
    // Never let a bookkeeping failure crash the worker loop. Report failure so
    // the caller stops draining and waits for the next scheduled poll (built-in
    // backoff) rather than spinning on a request it cannot terminate.
    Logger.red(
      `Deletion worker: failed to record ${status} for request ${doc.id}: ${
        writeErr instanceof Error ? writeErr.message : String(writeErr)
      }`
    );
    return false;
  }
};

// Outcome of one processing pass, used by the drain loop to decide whether to
// continue immediately or back off to the poll interval.
//   'idle'       - nothing pending; stop draining.
//   'progressed' - a request reached a terminal status; keep draining.
//   'stalled'    - found a request but could not make terminal progress (lost
//                  claim, or terminal write failed); stop draining and let the
//                  scheduled poll retry after POLL_INTERVAL_MS. Prevents a tight
//                  livelock when a request cannot be moved to done/error.
type ProcessResult = 'idle' | 'progressed' | 'stalled';

const processOne = async (): Promise<ProcessResult> => {
  const pending = await findPending();
  if (!pending) return 'idle';

  const claimed = await claim(pending);
  // Lost the claim (409). Do NOT re-pick the same doc immediately (that spins);
  // back off to the next scheduled poll.
  if (!claimed) return 'stalled';

  try {
    await performDeletion(claimed);
    const ok = await markTerminal(claimed, 'done');
    if (ok) Logger.black(`Deletion worker: completed request ${claimed.id}`);
    return ok ? 'progressed' : 'stalled';
  } catch (err) {
    Logger.red(
      `Deletion worker: request ${claimed.id} failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    const ok = await markTerminal(claimed, 'error', err);
    return ok ? 'progressed' : 'stalled';
  }
};

// One scheduler pass: drain pending requests while we make terminal progress,
// then reschedule. A 'stalled' or 'idle' result stops the drain so we wait a
// full poll interval (backoff) instead of spinning on a request we cannot
// terminate.
const tick = async (): Promise<void> => {
  if (running || stopped) return;
  running = true;
  try {
    let result: ProcessResult;
    do {
      result = await processOne();
    } while (!stopped && result === 'progressed');
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

// Exported for tests: run a single drain pass synchronously. Stops as soon as a
// pass does not make terminal progress (idle or stalled), so a request that
// cannot be terminated does not spin the loop.
export const __processAll = async (): Promise<void> => {
  while ((await processOne()) === 'progressed') {
    /* drain */
  }
};
