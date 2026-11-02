import { describe, it, expect } from 'vitest';
import stripDbFields from './stripDbFields';

describe('stripDbFields', () => {
  it('removes _id and _rev and keeps every other field', () => {
    expect(
      stripDbFields({ _id: 'x', _rev: '1-abc', a: 1, b: { c: 2 } })
    ).toEqual({ a: 1, b: { c: 2 } });
  });

  it('removes the internal per-flow segment duration bound', () => {
    expect(
      stripDbFields({ _id: 'x', a: 1, max_segment_duration_ns: '10' })
    ).toEqual({ a: 1 });
  });

  it('is a no-op when there are no db fields', () => {
    expect(stripDbFields({ a: 1 })).toEqual({ a: 1 });
  });
});
