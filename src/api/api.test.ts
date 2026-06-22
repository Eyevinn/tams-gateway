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

  it('returns JSON root paths for an application/json client even when UI is on', async () => {
    const server = api({ title: 'TAMS-Gateway', enableUi: true });
    const response = await server.inject({
      method: 'GET',
      url: '/',
      headers: { accept: 'application/json' }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(['flows', 'sources']);
    await server.close();
  });

  it('redirects a browser (Accept text/html) at the root to /ui when UI is enabled', async () => {
    const server = api({ title: 'TAMS-Gateway', enableUi: true });
    const response = await server.inject({
      method: 'GET',
      url: '/',
      headers: { accept: 'text/html,application/xhtml+xml' }
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/ui');
    await server.close();
  });

  it('does not redirect the root when the UI is disabled', async () => {
    const server = api({ title: 'TAMS-Gateway', enableUi: false });
    const response = await server.inject({
      method: 'GET',
      url: '/',
      headers: { accept: 'text/html' }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(['flows', 'sources']);
    await server.close();
  });
});
