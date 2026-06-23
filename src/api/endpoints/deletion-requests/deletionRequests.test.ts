import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import fastify, { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

vi.mock('../../../db/client', () => ({
  deletionRequestsClient: { list: vi.fn(), get: vi.fn() }
}));

import { deletionRequestsClient } from '../../../db/client';
import listDeletionRequests from './listDeletionRequests';
import getDeletionRequest from './getDeletionRequest';

const mock = deletionRequestsClient as unknown as { list: Mock; get: Mock };

const buildApp = (plugin: FastifyPluginCallback): FastifyInstance => {
  const app = fastify().withTypeProvider<TypeBoxTypeProvider>();
  app.register(plugin);
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listDeletionRequests', () => {
  it('returns an empty array when there are no requests', async () => {
    mock.list.mockResolvedValue({ rows: [] });

    const app = buildApp(listDeletionRequests);
    const res = await app.inject({
      method: 'GET',
      url: '/flow-delete-requests'
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await app.close();
  });

  it('lists requests without CouchDB bookkeeping fields', async () => {
    mock.list.mockResolvedValue({
      rows: [
        {
          doc: {
            _id: 'dr-1',
            _rev: '1-abc',
            id: 'dr-1',
            flow_id: 'flow-1',
            timerange_to_delete: '[0:0_4:0)',
            delete_flow: false,
            status: 'done'
          }
        }
      ]
    });

    const app = buildApp(listDeletionRequests);
    const res = await app.inject({
      method: 'GET',
      url: '/flow-delete-requests'
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body[0].id).toBe('dr-1');
    expect(body[0]._id).toBeUndefined();
    expect(body[0]._rev).toBeUndefined();
    await app.close();
  });
});

describe('getDeletionRequest', () => {
  it('returns a single request', async () => {
    mock.get.mockResolvedValue({
      _id: 'dr-1',
      id: 'dr-1',
      flow_id: 'flow-1',
      timerange_to_delete: '[0:0_4:0)',
      delete_flow: false,
      status: 'done'
    });

    const app = buildApp(getDeletionRequest);
    const res = await app.inject({
      method: 'GET',
      url: '/flow-delete-requests/dr-1'
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe('dr-1');
    expect(res.json()._id).toBeUndefined();
    await app.close();
  });

  it('returns 404 for an unknown request', async () => {
    mock.get.mockRejectedValue({ statusCode: 404 });

    const app = buildApp(getDeletionRequest);
    const res = await app.inject({
      method: 'GET',
      url: '/flow-delete-requests/missing'
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
