import { describe, it, expect } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import getService from './getService';

const buildApp = (): FastifyInstance => {
  const app = fastify().withTypeProvider<TypeBoxTypeProvider>();
  app.register(getService);
  return app;
};

describe('getService', () => {
  it('returns a service descriptor advertising the webhooks event stream', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/service' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.type).toMatch(/^urn:x-tams:service/);
    expect(body.api_version).toBe('8.1');
    expect(body.min_object_timeout).toBe('300:0');
    expect(body.event_stream_mechanisms).toContainEqual({ name: 'webhooks' });
    await app.close();
  });

  it('reports the dynamic gateway version and omits build outside a Docker build', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/service' });

    const body = res.json();
    // version is sourced from package.json (semver-ish), never hardcoded here.
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    // build is only stamped into the Docker image (build-time.txt); in dev and
    // under test there is no such file, so the field is omitted entirely.
    expect(body.build).toBeUndefined();
    await app.close();
  });
});
