const http = require('http');
const { AECS } = require('./aecs');
const { buildRuntimeConfig } = require('./runtime-config');

function getHealthPath(runtimeConfig = null) {
  const config = runtimeConfig || buildRuntimeConfig();
  return config.healthcheckPath || '/healthz';
}

async function checkDb(db) {
  if (!db || typeof db.get !== 'function') return true;
  try {
    await db.get('SELECT 1');
    return true;
  } catch (_error) {
    return false;
  }
}

async function collectMetrics(providers = []) {
  const metrics = {};
  for (const provider of providers) {
    if (typeof provider !== 'function') continue;
    try {
      const next = await provider();
      if (!next || typeof next !== 'object') continue;
      Object.assign(metrics, next);
    } catch (_error) {
      // Metrics should never take down the health endpoint.
    }
  }
  return metrics;
}

function startHealthServer({ db, port, runtimeConfig = null, metricsProviders = [] }) {
  const healthPath = getHealthPath(runtimeConfig);
  const server = http.createServer(async (req, res) => {
    const reqPath = req && req.url
      ? (new URL(req.url, 'http://127.0.0.1').pathname || '')
      : '';
    if (req.method !== 'GET' || reqPath !== healthPath) {
      res.statusCode = 404;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end('Not found');
      return;
    }

    const dbOk = await checkDb(db);
    let aecs = null;
    try {
      aecs = AECS.getMetrics();
    } catch (_error) {
      aecs = null;
    }
    const metrics = await collectMetrics(metricsProviders);

    const payload = {
      status: dbOk ? 'ok' : 'degraded',
      db: dbOk ? 'ok' : 'error',
      uptimeSec: Math.round(process.uptime()),
      timestamp: Date.now(),
      aecs,
      metrics
    };

    res.statusCode = dbOk ? 200 : 503;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(payload));
  });

  server.on('error', (err) => {
    console.error('Health check server error:', err);
  });

  server.listen(port, () => {
    const address = server.address();
    const boundPort = address && typeof address === 'object' ? address.port : port;
    console.log(`Health check listening on ${boundPort}${healthPath}`);
  });

  return server;
}

module.exports = { startHealthServer };
