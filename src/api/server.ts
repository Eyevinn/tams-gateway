import Logger from '../utils/Logger';
import api from './api';
import { initDatabases } from '../db/client';
import { loadConfig } from '../config';
import {
  startDeletionWorker,
  stopDeletionWorker
} from './utils/deletionWorker';

const initServer = async () => {
  // Validate required environment up front and fail fast on misconfiguration.
  const config = loadConfig();

  await initDatabases();

  const server = api({
    title: 'TAMS-Gateway',
    corsOrigin: config.corsOrigin,
    logLevel: config.logLevel,
    apiToken: config.apiToken,
    enableUi: config.enableUi
  });

  // Start the background deletion worker. It claims pending Flow Delete Requests
  // (status `created`) and runs the per-batch delete + reclaim to completion, and
  // on startup resumes any non-terminal request left behind by a previous
  // process so a pod restart recovers. Assumes a single gateway pod (see
  // deletionWorker.ts for the multi-pod follow-up).
  startDeletionWorker();

  // Close the server cleanly on termination so rolling deploys drain in-flight
  // requests instead of dropping them.
  const shutdown = async (signal: string) => {
    Logger.black(`Received ${signal}, shutting down`);
    try {
      stopDeletionWorker();
      await server.close();
      process.exit(0);
    } catch (err) {
      Logger.black(`Error during shutdown: ${err}`);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  server.listen({ port: config.port, host: '0.0.0.0' }, (err, address) => {
    if (err) {
      throw err;
    }
    Logger.black(`Server: ${address}`);
  });
};

export default initServer;
