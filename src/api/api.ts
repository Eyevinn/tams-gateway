import fastify from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Logger from '../utils/Logger';
import { createAuthHook } from './auth';
import healthcheck from './endpoints/healthcheck';
import readiness from './endpoints/readiness';
import errorHandler from './utils/error-handler';
import putFlow from './endpoints/flows/putFlow';
import listFlows from './endpoints/flows/listFlows';
import getFlow from './endpoints/flows/getFlow';
import deleteFlow from './endpoints/flows/deleteFlow';
import listSources from './endpoints/sources/listSources';
import postStorage from './endpoints/storage/postStorage';
import postSegments from './endpoints/segments/postSegments';
import listSegments from './endpoints/segments/listSegments';

export interface ApiOptions {
  title: string;
}

export default (opts: ApiOptions) => {
  const api = fastify({
    routerOptions: { ignoreTrailingSlash: true },
    // Structured request logging in all environments except tests.
    logger:
      process.env.NODE_ENV === 'test'
        ? false
        : { level: process.env.LOG_LEVEL || 'info' }
  }).withTypeProvider<TypeBoxTypeProvider>();

  // Restrict CORS to configured origins (comma-separated) when set.
  const corsOrigin = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((origin) => origin.trim())
    : true;
  api.register(cors, { origin: corsOrigin });
  api.setErrorHandler(errorHandler);

  // Bearer-token authentication. Enabled when API_TOKEN is set; public paths
  // (liveness, readiness, docs) and CORS preflight bypass it. Registering the
  // hook on the root instance applies it to every route registered below.
  const apiToken = process.env.API_TOKEN;
  if (apiToken) {
    api.addHook('onRequest', createAuthHook(apiToken));
  } else {
    Logger.black('Authentication disabled (API_TOKEN not set)');
  }
  api.register(swagger, {
    swagger: {
      info: {
        title: opts.title,
        description: 'API for accessing your TAMS flows.',
        version: 'v1'
      },
      tags: [
        {
          name: 'Healthcheck'
        },
        {
          name: 'Flows',
          description: 'Get, edit and delete flows'
        },
        {
          name: 'Sources',
          description: 'Get Sources'
        },
        {
          name: 'Storage & Segments',
          description: 'Create storage and get/post segments'
        }
      ]
    }
  });
  api.register(swaggerUI, {
    routePrefix: '/docs'
  });

  api.register(healthcheck, { title: opts.title });
  api.register(readiness);
  api.register(putFlow);
  api.register(listFlows);
  api.register(getFlow);
  api.register(deleteFlow);

  api.register(listSources);

  api.register(postStorage);
  api.register(postSegments);
  api.register(listSegments);

  return api;
};
