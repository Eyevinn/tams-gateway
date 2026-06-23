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
import getSource from './endpoints/sources/getSource';
import postStorage from './endpoints/storage/postStorage';
import postSegments from './endpoints/segments/postSegments';
import listSegments from './endpoints/segments/listSegments';
import deleteSegments from './endpoints/segments/deleteSegments';
import listDeletionRequests from './endpoints/deletion-requests/listDeletionRequests';
import getDeletionRequest from './endpoints/deletion-requests/getDeletionRequest';
import getHlsPlaylist from './endpoints/output/getHlsPlaylist';
import getService from './endpoints/service/getService';
import getStorageBackends from './endpoints/service/getStorageBackends';
import postWebhook from './endpoints/webhooks/postWebhook';
import listWebhooks from './endpoints/webhooks/listWebhooks';
import getWebhook from './endpoints/webhooks/getWebhook';
import putWebhook from './endpoints/webhooks/putWebhook';
import deleteWebhook from './endpoints/webhooks/deleteWebhook';
import ui from './endpoints/ui/ui';
import { Type } from '@sinclair/typebox';
import { flowsClient, sourcesClient } from '../db/client';
import propertyEndpoints, {
  PropertyClient
} from './endpoints/properties/propertyEndpoints';
import tagsEndpoints from './endpoints/properties/tagsEndpoints';
import CollectionItem from '../db/schemas/common/CollectionItem';
import { DEFAULT_ENABLE_UI, DEFAULT_LOG_LEVEL } from '../config';

// All runtime configuration the API needs is passed in by the caller (see
// server.ts), so this builder reads no environment itself and is trivially
// testable. The defaults keep it usable standalone (e.g. in tests).
export interface ApiOptions {
  title: string;
  corsOrigin?: string[] | boolean;
  logLevel?: string;
  apiToken?: string;
  // Built-in read-only inspector UI (ADR-007 D4). Defaults to DEFAULT_ENABLE_UI
  // so a bare api() call in tests still mirrors production behaviour.
  enableUi?: boolean;
}

export default (opts: ApiOptions) => {
  const api = fastify({
    routerOptions: { ignoreTrailingSlash: true },
    // Structured request logging in all environments except tests.
    logger:
      process.env.NODE_ENV === 'test'
        ? false
        : { level: opts.logLevel ?? DEFAULT_LOG_LEVEL }
  }).withTypeProvider<TypeBoxTypeProvider>();

  // Restrict CORS to the configured origins; default to reflecting any origin.
  api.register(cors, { origin: opts.corsOrigin ?? true });
  api.setErrorHandler(errorHandler);

  // Bearer-token authentication. Enabled when a token is configured; public
  // paths (liveness, readiness, docs) and CORS preflight bypass it. Registering
  // the hook on the root instance applies it to every route registered below.
  if (opts.apiToken) {
    api.addHook('onRequest', createAuthHook(opts.apiToken));
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
        },
        {
          name: 'Output',
          description: 'Playable HLS output'
        },
        {
          name: 'Service',
          description: 'Service descriptor'
        },
        {
          name: 'Webhooks',
          description: 'Register and manage event-notification webhooks'
        },
        {
          name: 'Flow Delete Requests',
          description: 'Monitor flow segment deletion requests'
        }
      ]
    }
  });
  api.register(swaggerUI, {
    routePrefix: '/docs'
  });

  const enableUi = opts.enableUi ?? DEFAULT_ENABLE_UI;
  api.register(healthcheck, { title: opts.title, enableUi });
  api.register(readiness);
  api.register(putFlow);
  api.register(listFlows);
  api.register(getFlow);
  api.register(deleteFlow);

  api.register(listSources);
  api.register(getSource);

  // Flow and source property + tag endpoints (TAMS /<resource>/{id}/<prop> and
  // /<resource>/{id}/tags[/{name}]), generated from a shared factory. The
  // clients are cast to the factory's loose document type. read_only is
  // flow-only, has no DELETE, and is NOT read-only-guarded (it must stay
  // settable to unlock a flow). Sources have no read_only, so their writes are
  // unguarded.
  const flowClient = flowsClient as unknown as PropertyClient;
  const sourceClient = sourcesClient as unknown as PropertyClient;
  api.register(
    propertyEndpoints({
      client: flowClient,
      basePath: '/flows/:id',
      resourceName: 'Flow',
      tag: 'Flows',
      field: 'description',
      valueSchema: Type.String()
    })
  );
  api.register(
    propertyEndpoints({
      client: flowClient,
      basePath: '/flows/:id',
      resourceName: 'Flow',
      tag: 'Flows',
      field: 'label',
      valueSchema: Type.String()
    })
  );
  api.register(
    propertyEndpoints({
      client: flowClient,
      basePath: '/flows/:id',
      resourceName: 'Flow',
      tag: 'Flows',
      field: 'read_only',
      valueSchema: Type.Boolean(),
      allowDelete: false,
      guardReadOnly: false
    })
  );
  api.register(
    propertyEndpoints({
      client: flowClient,
      basePath: '/flows/:id',
      resourceName: 'Flow',
      tag: 'Flows',
      field: 'max_bit_rate',
      valueSchema: Type.Integer()
    })
  );
  api.register(
    propertyEndpoints({
      client: flowClient,
      basePath: '/flows/:id',
      resourceName: 'Flow',
      tag: 'Flows',
      field: 'avg_bit_rate',
      valueSchema: Type.Integer()
    })
  );
  api.register(
    propertyEndpoints({
      client: flowClient,
      basePath: '/flows/:id',
      resourceName: 'Flow',
      tag: 'Flows',
      field: 'flow_collection',
      valueSchema: Type.Array(CollectionItem)
    })
  );
  api.register(
    tagsEndpoints({
      client: flowClient,
      basePath: '/flows/:id',
      resourceName: 'Flow',
      tag: 'Flows'
    })
  );
  api.register(
    propertyEndpoints({
      client: sourceClient,
      basePath: '/sources/:id',
      resourceName: 'Source',
      tag: 'Sources',
      field: 'description',
      valueSchema: Type.String(),
      guardReadOnly: false
    })
  );
  api.register(
    propertyEndpoints({
      client: sourceClient,
      basePath: '/sources/:id',
      resourceName: 'Source',
      tag: 'Sources',
      field: 'label',
      valueSchema: Type.String(),
      guardReadOnly: false
    })
  );
  api.register(
    tagsEndpoints({
      client: sourceClient,
      basePath: '/sources/:id',
      resourceName: 'Source',
      tag: 'Sources',
      guardReadOnly: false
    })
  );

  api.register(postStorage);
  api.register(postSegments);
  api.register(listSegments);
  api.register(deleteSegments);
  api.register(listDeletionRequests);
  api.register(getDeletionRequest);

  api.register(getHlsPlaylist);

  api.register(getService);
  api.register(getStorageBackends);
  api.register(postWebhook);
  api.register(listWebhooks);
  api.register(getWebhook);
  api.register(putWebhook);
  api.register(deleteWebhook);

  // Built-in read-only inspector UI (ADR-007). Registered only when enabled, so
  // the lean conformance API runs without the static handler or /ui route.
  if (enableUi) {
    api.register(ui);
  }

  return api;
};
