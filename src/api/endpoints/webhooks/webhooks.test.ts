import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import fastify, { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

vi.mock('../../../db/client', () => ({
  webhooksClient: {
    get: vi.fn(),
    insert: vi.fn(),
    list: vi.fn(),
    destroy: vi.fn()
  }
}));

import { webhooksClient } from '../../../db/client';
import postWebhook from './postWebhook';
import listWebhooks from './listWebhooks';
import getWebhook from './getWebhook';
import putWebhook from './putWebhook';
import deleteWebhook from './deleteWebhook';

const mock = webhooksClient as unknown as {
  get: Mock;
  insert: Mock;
  list: Mock;
  destroy: Mock;
};

const buildApp = (plugin: FastifyPluginCallback): FastifyInstance => {
  const app = fastify().withTypeProvider<TypeBoxTypeProvider>();
  app.register(plugin);
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('postWebhook', () => {
  it('registers a webhook, returns 201 with status started and never the secret', async () => {
    mock.insert.mockResolvedValue({ ok: true });

    const app = buildApp(postWebhook);
    const res = await app.inject({
      method: 'POST',
      url: '/service/webhooks',
      payload: {
        url: 'https://hook.example.com',
        events: ['flows/created', 'flows/updated'],
        api_key_name: 'Authorization',
        api_key_value: 'super-secret'
      }
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeTruthy();
    expect(body.status).toBe('started');
    expect(body.url).toBe('https://hook.example.com');
    // The secret is stored but MUST NOT be returned.
    expect(body.api_key_value).toBeUndefined();
    expect(mock.insert.mock.calls[0][0].api_key_value).toBe('super-secret');
    await app.close();
  });

  it('registers in the disabled state when requested', async () => {
    mock.insert.mockResolvedValue({ ok: true });

    const app = buildApp(postWebhook);
    const res = await app.inject({
      method: 'POST',
      url: '/service/webhooks',
      payload: {
        url: 'https://hook.example.com',
        events: ['flows/created'],
        status: 'disabled'
      }
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('disabled');
    await app.close();
  });

  it('rejects an unknown event type with 400', async () => {
    const app = buildApp(postWebhook);
    const res = await app.inject({
      method: 'POST',
      url: '/service/webhooks',
      payload: { url: 'https://hook.example.com', events: ['flows/bogus'] }
    });

    expect(res.statusCode).toBe(400);
    expect(mock.insert).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('listWebhooks', () => {
  it('lists webhooks without exposing the secret', async () => {
    mock.list.mockResolvedValue({
      rows: [
        {
          doc: {
            _id: 'wh-1',
            _rev: '1-abc',
            id: 'wh-1',
            url: 'https://hook.example.com',
            events: ['flows/created'],
            status: 'started',
            api_key_value: 'super-secret'
          }
        }
      ]
    });

    const app = buildApp(listWebhooks);
    const res = await app.inject({ method: 'GET', url: '/service/webhooks' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('wh-1');
    expect(body[0].api_key_value).toBeUndefined();
    expect(body[0]._id).toBeUndefined();
    await app.close();
  });
});

describe('getWebhook', () => {
  it('returns the webhook without the secret', async () => {
    mock.get.mockResolvedValue({
      _id: 'wh-1',
      id: 'wh-1',
      url: 'https://hook.example.com',
      events: ['flows/created'],
      status: 'started',
      api_key_value: 'super-secret'
    });

    const app = buildApp(getWebhook);
    const res = await app.inject({
      method: 'GET',
      url: '/service/webhooks/wh-1'
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().api_key_value).toBeUndefined();
    await app.close();
  });

  it('returns 404 for an unknown webhook', async () => {
    mock.get.mockRejectedValue({ statusCode: 404 });

    const app = buildApp(getWebhook);
    const res = await app.inject({
      method: 'GET',
      url: '/service/webhooks/missing'
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('putWebhook', () => {
  it('updates a webhook, reusing the stored revision and secret', async () => {
    mock.get.mockResolvedValue({
      _id: 'wh-1',
      _rev: '2-xyz',
      id: 'wh-1',
      url: 'https://old.example.com',
      events: ['flows/created'],
      status: 'started',
      api_key_value: 'kept-secret'
    });
    mock.insert.mockResolvedValue({ ok: true });

    const app = buildApp(putWebhook);
    const res = await app.inject({
      method: 'PUT',
      url: '/service/webhooks/wh-1',
      payload: {
        id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
        url: 'https://new.example.com',
        events: ['flows/created', 'flows/deleted'],
        status: 'created'
      }
    });

    expect(res.statusCode).toBe(201);
    const stored = mock.insert.mock.calls[0][0];
    expect(stored._rev).toBe('2-xyz');
    expect(stored.url).toBe('https://new.example.com');
    expect(stored.status).toBe('started');
    // Secret preserved when the update omits it.
    expect(stored.api_key_value).toBe('kept-secret');
    expect(res.json().api_key_value).toBeUndefined();
    await app.close();
  });

  it('returns 404 when updating a missing webhook', async () => {
    mock.get.mockRejectedValue({ statusCode: 404 });

    const app = buildApp(putWebhook);
    const res = await app.inject({
      method: 'PUT',
      url: '/service/webhooks/missing',
      payload: {
        id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
        url: 'https://new.example.com',
        events: ['flows/created'],
        status: 'created'
      }
    });

    expect(res.statusCode).toBe(404);
    expect(mock.insert).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects transitioning an error status directly to disabled', async () => {
    mock.get.mockResolvedValue({
      _id: 'wh-1',
      _rev: '3-err',
      id: 'wh-1',
      url: 'https://hook.example.com',
      events: ['flows/created'],
      status: 'error'
    });

    const app = buildApp(putWebhook);
    const res = await app.inject({
      method: 'PUT',
      url: '/service/webhooks/wh-1',
      payload: {
        id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
        url: 'https://hook.example.com',
        events: ['flows/created'],
        status: 'disabled'
      }
    });

    expect(res.statusCode).toBe(400);
    expect(mock.insert).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('deleteWebhook', () => {
  it('deletes an existing webhook and returns 204', async () => {
    mock.get.mockResolvedValue({ _id: 'wh-1', _rev: '1-abc', id: 'wh-1' });
    mock.destroy.mockResolvedValue({ ok: true });

    const app = buildApp(deleteWebhook);
    const res = await app.inject({
      method: 'DELETE',
      url: '/service/webhooks/wh-1'
    });

    expect(res.statusCode).toBe(204);
    expect(mock.destroy).toHaveBeenCalledWith('wh-1', '1-abc');
    await app.close();
  });

  it('returns 404 when deleting a missing webhook', async () => {
    mock.get.mockRejectedValue({ statusCode: 404 });

    const app = buildApp(deleteWebhook);
    const res = await app.inject({
      method: 'DELETE',
      url: '/service/webhooks/missing'
    });

    expect(res.statusCode).toBe(404);
    expect(mock.destroy).not.toHaveBeenCalled();
    await app.close();
  });
});
