import { describe, it, expect } from 'vitest';
import api from '../../api';

// The inspector UI (ADR-007) is flag-gated: registered only when enableUi is on.
describe('inspector UI (/ui)', () => {
  it('serves the inspector HTML when enableUi is true', async () => {
    const server = api({ title: 'TAMS-Gateway', enableUi: true });
    const res = await server.inject({ method: 'GET', url: '/ui' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<html');
    await server.close();
  });

  it('serves static assets under /ui/ when enabled', async () => {
    const server = api({ title: 'TAMS-Gateway', enableUi: true });
    const res = await server.inject({
      method: 'GET',
      url: '/ui/inspector.js'
    });
    expect(res.statusCode).toBe(200);
    await server.close();
  });

  it('does not register /ui when enableUi is false', async () => {
    const server = api({ title: 'TAMS-Gateway', enableUi: false });
    const res = await server.inject({ method: 'GET', url: '/ui' });
    expect(res.statusCode).toBe(404);
    await server.close();
  });
});
