import Logger from '../utils/Logger';
import api from './api';
import { initDatabases } from '../db/client';
import { loadConfig } from '../config';

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

  // Close the server cleanly on termination so rolling deploys drain in-flight
  // requests instead of dropping them.
  const shutdown = async (signal: string) => {
    Logger.black(`Received ${signal}, shutting down`);
    try {
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
