import api from './api';

describe('api', () => {
  it('responds with TAMS-Gateway - Ok!', async () => {
    const server = api({ title: 'TAMS-Gateway' });
    const response = await server.inject({
      method: 'GET',
      url: '/'
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('TAMS-Gateway - Ok');
  });
});
