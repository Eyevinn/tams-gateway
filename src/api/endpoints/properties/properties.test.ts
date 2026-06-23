import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import fastify, { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';

vi.mock('../../../db/client', () => ({
  flowsClient: { get: vi.fn(), insert: vi.fn() }
}));

import { flowsClient } from '../../../db/client';
import propertyEndpoints, { PropertyClient } from './propertyEndpoints';
import tagsEndpoints from './tagsEndpoints';

const flows = flowsClient as unknown as { get: Mock; insert: Mock };
const client = flowsClient as unknown as PropertyClient;

const buildApp = (plugin: FastifyPluginCallback): FastifyInstance => {
  const app = fastify().withTypeProvider<TypeBoxTypeProvider>();
  app.register(plugin);
  return app;
};

const description = () =>
  propertyEndpoints({
    client,
    basePath: '/flows/:id',
    resourceName: 'Flow',
    tag: 'Flows',
    field: 'description',
    valueSchema: Type.String()
  });

const readOnly = () =>
  propertyEndpoints({
    client,
    basePath: '/flows/:id',
    resourceName: 'Flow',
    tag: 'Flows',
    field: 'read_only',
    valueSchema: Type.Boolean(),
    allowDelete: false,
    guardReadOnly: false
  });

const tags = () =>
  tagsEndpoints({
    client,
    basePath: '/flows/:id',
    resourceName: 'Flow',
    tag: 'Flows'
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('propertyEndpoints (description)', () => {
  it('GET returns the property value', async () => {
    flows.get.mockResolvedValue({ _id: 'f1', description: 'hi' });
    const res = await buildApp(description()).inject({
      method: 'GET',
      url: '/flows/f1/description'
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toBe('hi');
  });

  it('GET returns null when the property is unset', async () => {
    flows.get.mockResolvedValue({ _id: 'f1' });
    const res = await buildApp(description()).inject({
      method: 'GET',
      url: '/flows/f1/description'
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toBeNull();
  });

  it('GET 404 when the flow is missing', async () => {
    flows.get.mockRejectedValue({ statusCode: 404 });
    const res = await buildApp(description()).inject({
      method: 'GET',
      url: '/flows/missing/description'
    });
    expect(res.statusCode).toBe(404);
  });

  it('PUT sets the property and returns 204', async () => {
    flows.get.mockResolvedValue({ _id: 'f1', _rev: '1', read_only: false });
    flows.insert.mockResolvedValue({ ok: true });
    const res = await buildApp(description()).inject({
      method: 'PUT',
      url: '/flows/f1/description',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify('new desc')
    });
    expect(res.statusCode).toBe(204);
    expect(flows.insert.mock.calls[0][0].description).toBe('new desc');
  });

  it('PUT 403 on a read-only flow', async () => {
    flows.get.mockResolvedValue({ _id: 'f1', _rev: '1', read_only: true });
    const res = await buildApp(description()).inject({
      method: 'PUT',
      url: '/flows/f1/description',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify('nope')
    });
    expect(res.statusCode).toBe(403);
    expect(flows.insert).not.toHaveBeenCalled();
  });

  it('PUT 400 on a wrong value type', async () => {
    flows.get.mockResolvedValue({ _id: 'f1', _rev: '1' });
    const res = await buildApp(description()).inject({
      method: 'PUT',
      url: '/flows/f1/description',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(42)
    });
    expect(res.statusCode).toBe(400);
  });

  it('DELETE removes the property and returns 204', async () => {
    flows.get.mockResolvedValue({ _id: 'f1', _rev: '1', description: 'x' });
    flows.insert.mockResolvedValue({ ok: true });
    const res = await buildApp(description()).inject({
      method: 'DELETE',
      url: '/flows/f1/description'
    });
    expect(res.statusCode).toBe(204);
    expect(flows.insert.mock.calls[0][0].description).toBeUndefined();
  });
});

describe('propertyEndpoints (read_only, unguarded, no delete)', () => {
  it('PUT read_only=false succeeds even when the flow is currently read-only', async () => {
    flows.get.mockResolvedValue({ _id: 'f1', _rev: '1', read_only: true });
    flows.insert.mockResolvedValue({ ok: true });
    const res = await buildApp(readOnly()).inject({
      method: 'PUT',
      url: '/flows/f1/read_only',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(false)
    });
    expect(res.statusCode).toBe(204);
    expect(flows.insert.mock.calls[0][0].read_only).toBe(false);
  });

  it('has no DELETE route', async () => {
    flows.get.mockResolvedValue({ _id: 'f1', _rev: '1' });
    const res = await buildApp(readOnly()).inject({
      method: 'DELETE',
      url: '/flows/f1/read_only'
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('tagsEndpoints', () => {
  it('GET collection returns the tags object', async () => {
    flows.get.mockResolvedValue({ _id: 'f1', tags: { a: '1' } });
    const res = await buildApp(tags()).inject({
      method: 'GET',
      url: '/flows/f1/tags'
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ a: '1' });
  });

  it('GET a tag value, 404 when absent', async () => {
    flows.get.mockResolvedValue({ _id: 'f1', tags: { a: '1' } });
    const ok = await buildApp(tags()).inject({
      method: 'GET',
      url: '/flows/f1/tags/a'
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toBe('1');

    flows.get.mockResolvedValue({ _id: 'f1', tags: { a: '1' } });
    const missing = await buildApp(tags()).inject({
      method: 'GET',
      url: '/flows/f1/tags/zzz'
    });
    expect(missing.statusCode).toBe(404);
  });

  it('PUT a tag sets it and returns 204', async () => {
    flows.get.mockResolvedValue({ _id: 'f1', _rev: '1', tags: { a: '1' } });
    flows.insert.mockResolvedValue({ ok: true });
    const res = await buildApp(tags()).inject({
      method: 'PUT',
      url: '/flows/f1/tags/b',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify('2')
    });
    expect(res.statusCode).toBe(204);
    expect(flows.insert.mock.calls[0][0].tags).toEqual({ a: '1', b: '2' });
  });

  it('DELETE a tag removes it and returns 204', async () => {
    flows.get.mockResolvedValue({
      _id: 'f1',
      _rev: '1',
      tags: { a: '1', b: '2' }
    });
    flows.insert.mockResolvedValue({ ok: true });
    const res = await buildApp(tags()).inject({
      method: 'DELETE',
      url: '/flows/f1/tags/a'
    });
    expect(res.statusCode).toBe(204);
    expect(flows.insert.mock.calls[0][0].tags).toEqual({ b: '2' });
  });

  it('PUT a tag 403 on a read-only flow', async () => {
    flows.get.mockResolvedValue({ _id: 'f1', _rev: '1', read_only: true });
    const res = await buildApp(tags()).inject({
      method: 'PUT',
      url: '/flows/f1/tags/b',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify('2')
    });
    expect(res.statusCode).toBe(403);
    expect(flows.insert).not.toHaveBeenCalled();
  });
});
