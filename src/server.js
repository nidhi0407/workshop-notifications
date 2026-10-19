// HTTP API for workshops and registrations. Zero external dependencies.
const http = require('node:http');
const path = require('node:path');
const { openDb } = require('./db');
const { createService, HttpError } = require('./service');
const { createDispatcher } = require('./dispatcher');

const PORT = Number(process.env.PORT || 3000);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data.db');
const NOTIFIER_URL = process.env.NOTIFIER_URL || 'http://localhost:4000/notify';

const db = openDb(DB_FILE);
const service = createService(db);
const dispatcher = createDispatcher(db, {
  notifierUrl: NOTIFIER_URL,
  log: (m) => console.log(`[dispatcher] ${m}`),
});

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); }
      catch { reject(new HttpError(400, 'invalid_json', 'Body must be valid JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

// [method, regex, handler(match, body, url)]
const routes = [
  ['GET', /^\/health$/, () => [200, { ok: true, notifications: service.stats() }]],
  ['POST', /^\/workshops$/, (_, b) => [201, service.createWorkshop(b)]],
  ['GET', /^\/workshops\/(\d+)$/, (m) => [200, service.getWorkshop(m[1])]],
  ['POST', /^\/workshops\/(\d+)\/registrations$/,
    (m, b) => [201, service.register(m[1], b.memberId)]],
  ['POST', /^\/workshops\/(\d+)\/cancel$/, (m) => [200, service.cancel(m[1])]],
  ['GET', /^\/notifications$/,
    (_, __, url) => [200, service.listNotifications(url.searchParams.get('status'))]],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    for (const [method, re, handler] of routes) {
      const m = url.pathname.match(re);
      if (m && req.method === method) {
        const body = method === 'POST' ? await readJson(req) : {};
        const [status, data] = handler(m, body, url);
        return send(res, status, data);
      }
    }
    send(res, 404, { error: 'not_found', message: 'No such route' });
  } catch (err) {
    if (err instanceof HttpError) {
      return send(res, err.status, { error: err.code, message: err.message });
    }
    console.error(err);
    send(res, 500, { error: 'internal', message: 'Internal error' });
  }
});

server.listen(PORT, () => {
  console.log(`[api] listening on http://localhost:${PORT} (db: ${DB_FILE})`);
  console.log(`[api] notifier: ${NOTIFIER_URL}`);
  dispatcher.start();
});

function shutdown() {
  dispatcher.stop();
  server.close(() => { db.close(); process.exit(0); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
