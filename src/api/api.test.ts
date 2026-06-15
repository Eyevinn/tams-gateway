import { describe, it, expect } from 'vitest';
import api from './api';

describe('api', () => {
  it('lists the available root paths', async () => {
    const server = api({ title: 'TAMS-Gateway' });
    const response = await server.inject({
      method: 'GET',
      url: '/'
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual(['flows', 'sources']);
  });
});
