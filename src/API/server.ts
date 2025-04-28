import Logger from '../utils/Logger';
import api from './api';

const initServer = () => {
  const server = api({ title: 'TAMS-Gateway' });

  const PORT = process.env.PORT ? Number(process.env.PORT) : 8000;

  server.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
    if (err) {
      throw err;
    }
    Logger.black(`Server: ${address}`);
  });
};

export default initServer;
