import { describe, it, expect } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
import { createAuthHook } from './auth';

const TOKEN = 'secret-token';

const build = (): FastifyInstance => {
  const app = fastify();
  app.addHook('onRequest', createAuthHook(TOKEN));
  app.get('/', async () => 'ok');
  app.get('/readiness', async () => 'ok');
  app.get('/flows', async () => 'protected');
  return app;
};

describe('createAuthHook', () => {
  it('rejects a protected route without a token', async () => {
    const app = build();
    const res = await app.inject({ method: 'GET', url: '/flows' });
    expect(res.statusCode).toBe(401);
    // Error body matches the shared ErrorResponse shape ({ code, message }).
    expect(res.json()).toEqual({ code: 401, message: 'Unauthorized' });
    await app.close();
  });

  it('rejects a wrong token', async () => {
    const app = build();
    const res = await app.inject({
      method: 'GET',
      url: '/flows',
      headers: { authorization: 'Bearer wrong' }
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('accepts the correct token', async () => {
    const app = build();
    const res = await app.inject({
      method: 'GET',
      url: '/flows',
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('leaves public paths open', async () => {
    const app = build();
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(
      200
    );
    expect(
      (await app.inject({ method: 'GET', url: '/readiness' })).statusCode
    ).toBe(200);
    await app.close();
  });
});
