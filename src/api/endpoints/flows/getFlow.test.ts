import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

vi.mock('../../../db/client', () => ({
  flowsClient: { get: vi.fn() }
}));

import { flowsClient } from '../../../db/client';
import getFlow from './getFlow';

const flows = flowsClient as unknown as { get: Mock };

const buildApp = (): FastifyInstance => {
  const app = fastify().withTypeProvider<TypeBoxTypeProvider>();
  app.register(getFlow);
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getFlow', () => {
  it('returns the stored flow verbatim without CouchDB _id/_rev', async () => {
    // An audio flow whose essence_parameters (sample_rate/channels) are not in
    // the gateway's flat schema: returning verbatim keeps them so the response
    // still validates against flow.json.
    flows.get.mockResolvedValue({
      _id: 'flow-1',
      _rev: '3-abc',
      id: 'flow-1',
      source_id: 'src-1',
      format: 'urn:x-nmos:format:audio',
      codec: 'audio/aac',
      essence_parameters: { sample_rate: 48000, channels: 2 }
    });

    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/flows/flow-1' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body._id).toBeUndefined();
    expect(body._rev).toBeUndefined();
    expect(body.essence_parameters).toEqual({
      sample_rate: 48000,
      channels: 2
    });
    await app.close();
  });
});
