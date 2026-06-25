import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

vi.mock('../../db/client', () => ({
  deletionRequestsClient: { find: vi.fn(), insert: vi.fn(), get: vi.fn() },
  DELETION_REQUESTS_STATUS_INDEX: { ddoc: 'x', name: 'y' }
}));
vi.mock('../../db/withCouchRetry', () => ({
  __esModule: true,
  default: (op: () => Promise<unknown>) => op()
}));
vi.mock('./performDeletion', () => ({
  __esModule: true,
  default: vi.fn(async () => ({ deleted: 0, deletedRange: null }))
}));

import { deletionRequestsClient } from '../../db/client';
import performDeletion from './performDeletion';
import { __processAll } from './deletionWorker';
import { DeletionRequestDoc } from '../../db/schemas/deletion-requests/DeletionRequest';

const requests = deletionRequestsClient as unknown as {
  find: Mock;
  insert: Mock;
  get: Mock;
};
const perform = performDeletion as unknown as Mock;

const makeDoc = (
  over: Partial<DeletionRequestDoc> = {}
): DeletionRequestDoc => ({
  _id: 'dr-1',
  _rev: '1-abc',
  id: 'dr-1',
  flow_id: 'flow-1',
  timerange_to_delete: '_',
  delete_flow: true,
  status: 'created',
  created: '2026-06-25T00:00:00.000Z',
  updated: '2026-06-25T00:00:00.000Z',
  ...over
});

// Serve `docs` one at a time across successive find() calls, then nothing. The
// worker drains until find returns no pending request.
const servePending = (docs: DeletionRequestDoc[]) => {
  let i = 0;
  requests.find.mockImplementation(async (q: { selector: unknown }) => {
    void q;
    const next = docs[i++];
    return { docs: next ? [next] : [] };
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  requests.insert.mockResolvedValue({ ok: true, rev: '2-def' });
  perform.mockResolvedValue({ deleted: 0, deletedRange: null });
  // markTerminal re-reads the latest doc before writing done/error; default it
  // to the claimed (started, non-terminal) state.
  requests.get.mockResolvedValue(makeDoc({ status: 'started', _rev: '2-def' }));
});

describe('deletion worker', () => {
  it('claims a created request, runs the delete, and marks it done', async () => {
    servePending([makeDoc({ status: 'created' })]);

    await __processAll();

    expect(perform).toHaveBeenCalledTimes(1);
    // First insert claims it (status started), second marks it done.
    const statuses = requests.insert.mock.calls.map((c) => c[0].status);
    expect(statuses).toEqual(['started', 'done']);
  });

  it('resumes a non-terminal (started) request left by a previous process', async () => {
    // A request stuck in `started` (a crashed/restarted pod) is re-claimed and
    // re-run on the next poll, then finished.
    servePending([makeDoc({ status: 'started', _rev: '5-stale' })]);

    await __processAll();

    expect(perform).toHaveBeenCalledTimes(1);
    // It is still finished to done.
    const statuses = requests.insert.mock.calls.map((c) => c[0].status);
    expect(statuses).toContain('done');
  });

  it('sets status error (without crashing the worker) when the delete fails', async () => {
    servePending([makeDoc({ status: 'created' })]);
    perform.mockRejectedValue(new Error('couch exploded'));
    // markTerminal re-reads the latest doc before writing the error status.
    requests.get.mockResolvedValue(
      makeDoc({ status: 'started', _rev: '2-def' })
    );

    // Must resolve, not throw: a failed request never crashes the loop.
    await expect(__processAll()).resolves.toBeUndefined();

    const errorWrite = requests.insert.mock.calls
      .map((c) => c[0])
      .find((d) => d.status === 'error');
    expect(errorWrite).toBeDefined();
    expect(errorWrite.error.summary).toBe('couch exploded');
  });

  it('does not spin when a failed request cannot be moved to a terminal status', async () => {
    // performDeletion fails AND the terminal-status write fails (e.g. CouchDB
    // outage): the request stays non-terminal. The drain loop must STOP after
    // this pass (return without spinning), not re-pick the same doc forever.
    let findCalls = 0;
    requests.find.mockImplementation(async () => {
      findCalls++;
      return { docs: [makeDoc({ status: 'started' })] };
    });
    perform.mockRejectedValue(new Error('down'));
    // markTerminal's get/insert both fail, so it cannot persist 'error'.
    requests.get.mockRejectedValue(new Error('couch unreachable'));

    await expect(__processAll()).resolves.toBeUndefined();

    // One claim attempt and one terminal-write attempt for the single pass; the
    // loop did not iterate again on the same un-terminable request.
    expect(perform).toHaveBeenCalledTimes(1);
    expect(findCalls).toBe(1);
  });

  it('does not spin on a lost claim (409)', async () => {
    // The claim insert conflicts (another writer moved the doc). The worker must
    // back off, not re-pick the same doc in a tight loop.
    let findCalls = 0;
    requests.find.mockImplementation(async () => {
      findCalls++;
      return { docs: [makeDoc({ status: 'started' })] };
    });
    // First insert is the claim; make it 409.
    requests.insert.mockRejectedValue({ statusCode: 409 });

    await expect(__processAll()).resolves.toBeUndefined();

    expect(perform).not.toHaveBeenCalled();
    expect(findCalls).toBe(1);
  });

  it('does nothing when there are no pending requests', async () => {
    servePending([]);

    await __processAll();

    expect(perform).not.toHaveBeenCalled();
    expect(requests.insert).not.toHaveBeenCalled();
  });

  it('drains multiple pending requests in one pass', async () => {
    servePending([
      makeDoc({ id: 'dr-1', _id: 'dr-1', status: 'created' }),
      makeDoc({ id: 'dr-2', _id: 'dr-2', status: 'created' })
    ]);

    await __processAll();

    expect(perform).toHaveBeenCalledTimes(2);
  });
});
