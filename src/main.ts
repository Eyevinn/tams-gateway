import initServer from './api/server';

// Start server
initServer().catch((err) => {
  console.error(err);
  process.exit(1);
});
