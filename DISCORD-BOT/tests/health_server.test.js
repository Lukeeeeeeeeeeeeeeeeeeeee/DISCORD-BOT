const http = require('http');
const { startHealthServer } = require('../src/lib/health-server');

async function requestJson(port, pathName) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathName,
      method: 'GET'
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          body: JSON.parse(body)
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('health server', () => {
  test('exposes db, AECS, and custom metrics on the configured path', async () => {
    const server = startHealthServer({
      db: { get: jest.fn().mockResolvedValue({ ok: 1 }) },
      port: 0,
      runtimeConfig: { healthcheckPath: '/readyz' },
      metricsProviders: [
        async () => ({ analytics: { pendingWrites: 7 } })
      ]
    });

    await new Promise((resolve) => server.on('listening', resolve));
    const port = server.address().port;
    const response = await requestJson(port, '/readyz');

    expect(response.statusCode).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.db).toBe('ok');
    expect(response.body.metrics).toEqual({
      analytics: { pendingWrites: 7 }
    });

    await new Promise((resolve) => server.close(resolve));
  });
});
