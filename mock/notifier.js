// Mock notification service. Pretends to send email/SMS and is deliberately
// unreliable so the backend's retry logic has something to deal with.
//
//   FAIL_RATE     chance of an immediate HTTP 503           (default 0.25)
//   TIMEOUT_RATE  chance of hanging and never answering     (default 0.10)
//   PORT          default 4000
//
// A "timeout" here is the nasty kind: the message IS recorded as delivered,
// but the response never arrives. The sender has to retry, and the retry
// must not produce a second delivery. That is what the idempotency key is for.
const http = require('node:http');

const PORT = Number(process.env.PORT || 4000);
let FAIL_RATE = Number(process.env.FAIL_RATE ?? 0.25);
let TIMEOUT_RATE = Number(process.env.TIMEOUT_RATE ?? 0.1);
let down = false;
const blocked = new Set(); // member ids that always fail (demo: one bad recipient)

const delivered = new Map(); // idempotency key -> delivery record
let duplicatesIgnored = 0;

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');

    if (req.method === 'POST' && url.pathname === '/notify') {
      if (down) return json(res, 503, { error: 'outage' });
      const key = req.headers['idempotency-key'];
      if (!key) return json(res, 400, { error: 'missing idempotency-key' });

      if (delivered.has(key)) {
        duplicatesIgnored++;
        console.log(`[notifier] duplicate ignored  ${key}`);
        return json(res, 200, { delivered: true, duplicate: true });
      }
      const msg = JSON.parse(body || '{}');
      if (blocked.has(msg.to)) {
        console.log(`[notifier] blocked recipient  ${key}`);
        return json(res, 503, { error: 'recipient unreachable' });
      }
      const roll = Math.random();
      if (roll < FAIL_RATE) {
        console.log(`[notifier] random 503         ${key}`);
        return json(res, 503, { error: 'random failure' });
      }
      delivered.set(key, { key, ...msg, at: new Date().toISOString() });
      if (roll < FAIL_RATE + TIMEOUT_RATE) {
        console.log(`[notifier] delivered, then hung (simulated lost response) ${key}`);
        return; // never respond
      }
      console.log(`[notifier] delivered          ${key} -> ${msg.to}`);
      return json(res, 200, { delivered: true });
    }

    // --- control endpoints used by the demo ---
    if (req.method === 'GET' && url.pathname === '/deliveries') {
      return json(res, 200, { count: delivered.size, duplicatesIgnored,
        deliveries: [...delivered.values()] });
    }
    if (req.method === 'POST' && url.pathname === '/admin/outage') {
      down = JSON.parse(body || '{}').down !== false;
      console.log(`[notifier] outage = ${down}`);
      return json(res, 200, { down });
    }
    if (req.method === 'POST' && url.pathname === '/admin/block') {
      const b = JSON.parse(body || '{}');
      if (b.blocked) blocked.add(b.member); else blocked.delete(b.member);
      console.log(`[notifier] ${b.member} blocked = ${!!b.blocked}`);
      return json(res, 200, { blocked: [...blocked] });
    }
    if (req.method === 'POST' && url.pathname === '/admin/rates') {
      const b = JSON.parse(body || '{}');
      if (b.failRate !== undefined) FAIL_RATE = b.failRate;
      if (b.timeoutRate !== undefined) TIMEOUT_RATE = b.timeoutRate;
      return json(res, 200, { failRate: FAIL_RATE, timeoutRate: TIMEOUT_RATE });
    }
    json(res, 404, { error: 'not_found' });
  });
}).listen(PORT, () => {
  console.log(`[notifier] listening on http://localhost:${PORT} ` +
    `(fail ${FAIL_RATE}, timeout ${TIMEOUT_RATE})`);
});
