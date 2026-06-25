import { describe, it, expect, vi } from 'vitest';
import withCouchRetry from './withCouchRetry';

// baseDelayMs=0 keeps the exponential backoff instant in tests.
const NO_DELAY = 0;

describe('withCouchRetry', () => {
  it('returns the result without retrying when the op succeeds', async () => {
    const op = vi.fn().mockResolvedValue('ok');
    const result = await withCouchRetry(op, 4, NO_DELAY);
    expect(result).toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('retries on a transient 503 and eventually succeeds', async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce({ statusCode: 503 })
      .mockRejectedValueOnce({ statusCode: 503 })
      .mockResolvedValue('ok');
    const result = await withCouchRetry(op, 4, NO_DELAY);
    expect(result).toBe('ok');
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('retries on 429', async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce({ statusCode: 429 })
      .mockResolvedValue('ok');
    await expect(withCouchRetry(op, 4, NO_DELAY)).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a non-transient error (e.g. 404) and rethrows it', async () => {
    const op = vi.fn().mockRejectedValue({ statusCode: 404 });
    await expect(withCouchRetry(op, 4, NO_DELAY)).rejects.toMatchObject({
      statusCode: 404
    });
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('gives up after the retry budget is exhausted and rethrows the last error', async () => {
    const op = vi.fn().mockRejectedValue({ statusCode: 503 });
    await expect(withCouchRetry(op, 2, NO_DELAY)).rejects.toMatchObject({
      statusCode: 503
    });
    // initial attempt + 2 retries
    expect(op).toHaveBeenCalledTimes(3);
  });
});
