const http = require('http');
const url = require('url');

function getHealthPath() {
  const raw = String(process.env.HEALTHCHECK_PATH || '').trim();
  return raw || '/healthz';
}

async function checkDb(db) {
  if (!db || typeof db.get !== 'function') return true;
  try {
    await db.get('SELECT 1');
    return true;
  } catch (e) {
    return false;
  }
}

function startHealthServer({ db, port }) {
  const healthPath = getHealthPath();
  const server = http.createServer(async (req, res) => {
    const reqPath = req && req.url ? (url.parse(req.url).pathname || '') : '';
    if (req.method !== 'GET' || reqPath !== healthPath) {
      res.statusCode = 404;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end('Not found');
      return;
    }

    const dbOk = await checkDb(db);
    const payload = {
      status: dbOk ? 'ok' : 'degraded',
      db: dbOk ? 'ok' : 'error',
      uptimeSec: Math.round(process.uptime()),
      timestamp: Date.now()
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
    console.log(`Health check listening on ${port}${healthPath}`);
  });

  return server;
}

module.exports = { startHealthServer };
