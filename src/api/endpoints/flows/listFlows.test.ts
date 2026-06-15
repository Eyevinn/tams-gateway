import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

vi.mock('../../../db/client', () => ({
  flowsClient: { list: vi.fn(), find: vi.fn() }
}));

import { flowsClient } from '../../../db/client';
import listFlows from './listFlows';

const flows = flowsClient as unknown as { list: Mock; find: Mock };

const buildApp = (): FastifyInstance => {
  const app = fastify().withTypeProvider<TypeBoxTypeProvider>();
  app.register(listFlows);
  return app;
};

const flow = {
  id: 'flow-1',
  source_id: 'src-1',
  codec: 'video/mp2t',
  format: 'urn:x-nmos:format:video',
  essence_parameters: { frame_width: 1920, frame_height: 1080 }
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listFlows', () => {
  it('lists all flows via list() when no filters are given', async () => {
    flows.list.mockResolvedValue({ rows: [{ doc: flow }] });

    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/flows' });

    expect(res.statusCode).toBe(200);
    expect(flows.list).toHaveBeenCalledTimes(1);
    expect(flows.find).not.toHaveBeenCalled();
    expect(res.json()).toEqual([flow]);
    await app.close();
  });

  it('filters via find() on scalar fields', async () => {
    flows.find.mockResolvedValue({ docs: [flow] });

    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/flows?source_id=src-1&format=urn:x-nmos:format:video&frame_width=1920'
    });

    expect(res.statusCode).toBe(200);
    expect(flows.list).not.toHaveBeenCalled();
    const selector = flows.find.mock.calls[0][0].selector;
    expect(selector.source_id).toBe('src-1');
    expect(selector.format).toBe('urn:x-nmos:format:video');
    expect(selector['essence_parameters.frame_width']).toBe(1920);
    await app.close();
  });

  it('translates tag and tag_exists filters to nested selectors', async () => {
    flows.find.mockResolvedValue({ docs: [] });

    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/flows?tag.location=studio-a&tag_exists.archived=true'
    });

    expect(res.statusCode).toBe(200);
    const selector = flows.find.mock.calls[0][0].selector;
    expect(selector['tags.location']).toBe('studio-a');
    expect(selector['tags.archived']).toEqual({ $exists: true });
    await app.close();
  });
});
