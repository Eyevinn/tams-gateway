import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

const send = vi.fn();
const destroy = vi.fn();

vi.mock('@aws-sdk/client-s3', () => ({
  // S3Client is constructed with `new`, so the mock must be constructible.
  S3Client: class {
    send = send;
    destroy = destroy;
  },
  // Capture the command input so assertions can read Bucket/Delete.
  DeleteObjectsCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
}));
vi.mock('@aws-sdk/credential-providers', () => ({
  fromEnv: vi.fn(() => ({}))
}));

import deleteS3Objects from './deleteS3Objects';

const sendMock = send as Mock;

// Each send() call receives a DeleteObjectsCommand instance; the mock command
// stores its constructor argument on `.input`.
const commandInput = (callIndex: number) =>
  sendMock.mock.calls[callIndex][0].input;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('deleteS3Objects', () => {
  it('returns immediately for an empty list without calling S3', async () => {
    const result = await deleteS3Objects([]);
    expect(result).toEqual({ deleted: [], errors: [] });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('issues one bulk DeleteObjects per bucket with the parsed keys', async () => {
    sendMock.mockResolvedValue({
      Deleted: [{ Key: 'obj-1' }, { Key: 'nested/obj-2' }],
      Errors: []
    });

    const result = await deleteS3Objects([
      'tams-bucket/obj-1',
      'tams-bucket/nested/obj-2'
    ]);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const input = commandInput(0);
    expect(input.Bucket).toBe('tams-bucket');
    expect(input.Delete.Objects).toEqual([
      { Key: 'obj-1' },
      { Key: 'nested/obj-2' }
    ]);
    expect(result.deleted.sort()).toEqual([
      'tams-bucket/nested/obj-2',
      'tams-bucket/obj-1'
    ]);
    expect(result.errors).toEqual([]);
    expect(destroy).toHaveBeenCalled();
  });

  it('splits objects across buckets into separate requests', async () => {
    sendMock
      .mockResolvedValueOnce({ Deleted: [{ Key: 'a' }], Errors: [] })
      .mockResolvedValueOnce({ Deleted: [{ Key: 'b' }], Errors: [] });

    const result = await deleteS3Objects(['bucket-x/a', 'bucket-y/b']);

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(result.deleted.sort()).toEqual(['bucket-x/a', 'bucket-y/b']);
  });

  it('reports per-object errors returned by the store', async () => {
    sendMock.mockResolvedValue({
      Deleted: [{ Key: 'ok' }],
      Errors: [{ Key: 'bad', Message: 'AccessDenied' }]
    });

    const result = await deleteS3Objects(['b/ok', 'b/bad']);

    expect(result.deleted).toEqual(['b/ok']);
    expect(result.errors).toEqual([
      { object_id: 'b/bad', message: 'AccessDenied' }
    ]);
  });

  it('rejects malformed object_ids without sending them to S3', async () => {
    sendMock.mockResolvedValue({ Deleted: [{ Key: 'ok' }], Errors: [] });

    const result = await deleteS3Objects(['no-slash', 'b/ok', 'trailing/']);

    // Only the well-formed id is sent.
    const input = commandInput(0);
    expect(input.Delete.Objects).toEqual([{ Key: 'ok' }]);
    expect(result.deleted).toEqual(['b/ok']);
    expect(result.errors.map((e) => e.object_id).sort()).toEqual([
      'no-slash',
      'trailing/'
    ]);
  });
});
