import fastify from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import healthcheck from './endpoints/healthcheck';
import errorHandler from './utils/error-handler';
import putFlow from './endpoints/flows/putFlow';
import listFlows from './endpoints/flows/listFlows';
import getFlow from './endpoints/flows/getFlow';
import deleteFlow from './endpoints/flows/deleteFlow';

export interface ApiOptions {
  title: string;
}

export default (opts: ApiOptions) => {
  const api = fastify({
    ignoreTrailingSlash: true
  }).withTypeProvider<TypeBoxTypeProvider>();

  api.register(cors);
  api.setErrorHandler(errorHandler);
  api.register(swagger, {
    swagger: {
      info: {
        title: opts.title,
        description: 'API for accessing your TAMS flows.',
        version: 'v1'
      }
    }
  });
  api.register(swaggerUI, {
    routePrefix: '/docs'
  });

  api.register(healthcheck, { title: opts.title });
  api.register(putFlow);
  api.register(listFlows);
  api.register(getFlow);
  api.register(deleteFlow);

  return api;
};
