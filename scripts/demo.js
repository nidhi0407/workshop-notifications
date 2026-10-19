// End-to-end demo. Starts the mock notifier and the API, then walks through
// every requirement in the brief and checks the result. Exits non-zero if
// any check fails, so it doubles as the test suite (`npm test`).
//
//   node scripts/demo.js
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const API = 'http://localhost:3100';
const MOCK = 'http://localhost:4100';
const DB_FILE = path.join(os.tmpdir(), `workshop-demo-${process.pid}.db`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

function step(title) { console.log(`\n\x1b[1m━━ ${title}\x1b[0m`); }
function check(cond, msg) {
  console.log(`  ${cond ? '\x1b[32m✔' : '\x1b[31m✘'} ${msg}\x1b[0m`);
  if (!cond) failures++;
}

async function call(base, method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}
const api = (m, p, b) => call(API, m, p, b);
const mock = (m, p, b) => call(MOCK, m, p, b);

function startProcess(name, file, env) {
  const child = spawn(process.execPath, ['--no-warnings', file], {
    cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const show = process.env.VERBOSE;
  child.stdout.on('data', (d) => show && process.stdout.write(`    ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`    [${name} err] ${d}`));
  return child;
}

async function waitFor(fn, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch { /* not up yet */ }
    await sleep(150);
  }
  return false;
}

const startApi = async () => {
  const p = startProcess('api', 'src/server.js',
    { PORT: '3100', DB_FILE, NOTIFIER_URL: `${MOCK}/notify` });
  await waitFor(async () => (await api('GET', '/health')).status === 200);
  return p;
};

async function pendingCount() {
  return (await api('GET', '/health')).body.notifications.pending;
}

(async () => {
  let mockProc, apiProc;
  try {
    mockProc = startProcess('mock', 'mock/notifier.js',
      { PORT: '4100', FAIL_RATE: '0.25', TIMEOUT_RATE: '0.10' });
    await waitFor(async () => (await mock('GET', '/deliveries')).status === 200);
    apiProc = await startApi();
    console.log('Mock notifier fails 25% of requests and loses 10% of responses after delivering.');

    // 1 ─────────────────────────────────────────────────────────────
    step('1. Registration returns immediately, confirmation is sent later');
    const ws = (await api('POST', '/workshops', { title: 'Intro to Go', capacity: 3 })).body;
    const t0 = Date.now();
    const reg = await api('POST', `/workshops/${ws.id}/registrations`, { memberId: 'alice' });
    const ms = Date.now() - t0;
    check(reg.status === 201, `alice registered (HTTP ${reg.status}) in ${ms}ms`);
    check(reg.body.confirmation === 'queued', 'response says confirmation is queued, not sent');
    await api('POST', `/workshops/${ws.id}/registrations`, { memberId: 'bob' });
    await api('POST', `/workshops/${ws.id}/registrations`, { memberId: 'carol' });

    // 2 ─────────────────────────────────────────────────────────────
    step('2. Failed registrations produce no confirmation');
    const dup = await api('POST', `/workshops/${ws.id}/registrations`, { memberId: 'alice' });
    check(dup.status === 409 && dup.body.error === 'already_registered',
      `alice registering twice is rejected (${dup.status} ${dup.body.error})`);
    const full = await api('POST', `/workshops/${ws.id}/registrations`, { memberId: 'dave' });
    check(full.status === 409 && full.body.error === 'full',
      `dave rejected because workshop is full (${full.status} ${full.body.error})`);
    const owed = (await api('GET', '/notifications')).body;
    check(owed.length === 3, `exactly 3 confirmations queued (got ${owed.length})`);
    check(!owed.some((n) => n.member_id === 'dave'), 'no confirmation exists for dave');

    // 3 ─────────────────────────────────────────────────────────────
    step('3. Retries get every confirmation through an unreliable notifier');
    check(await waitFor(async () => (await pendingCount()) === 0), 'all confirmations delivered');
    const sent = (await api('GET', '/notifications?status=sent')).body;
    const attempts = sent.reduce((a, n) => a + n.attempts, 0);
    console.log(`  ${sent.length} confirmations took ${attempts} attempts in total`);

    // 4 ─────────────────────────────────────────────────────────────
    step('4. Backend crashes after saving registrations, confirmations still arrive');
    await mock('POST', '/admin/outage', { down: true });
    const ws2 = (await api('POST', '/workshops', { title: 'Docker Basics' })).body;
    for (const m of ['erin', 'frank', 'grace']) {
      await api('POST', `/workshops/${ws2.id}/registrations`, { memberId: m });
    }
    await sleep(800);
    check((await pendingCount()) === 3, 'notifier is down: 3 confirmations waiting');
    apiProc.kill('SIGKILL');
    await sleep(300);
    console.log('  API killed with SIGKILL (no graceful shutdown)');
    await mock('POST', '/admin/outage', { down: false });
    apiProc = await startApi();
    console.log('  API restarted, notifier back up');
    check(await waitFor(async () => (await pendingCount()) === 0),
      'all 3 confirmations delivered after restart');

    // 5 ─────────────────────────────────────────────────────────────
    step('5. Cancellation notifies everyone; one bad recipient does not block others');
    await mock('POST', '/admin/block', { member: 'bob', blocked: true });
    const cancel = await api('POST', `/workshops/${ws.id}/cancel`);
    check(cancel.body.notificationsQueued === 3, 'cancellation queued for alice, bob, carol');
    const othersDone = await waitFor(async () => {
      const rows = (await api('GET', '/notifications?status=sent')).body;
      return ['alice', 'carol'].every((m) =>
        rows.some((n) => n.type === 'cancellation' && n.member_id === m));
    });
    check(othersDone, 'alice and carol notified while bob keeps failing');
    const bobRow = (await api('GET', '/notifications?status=pending')).body
      .find((n) => n.member_id === 'bob');
    check(bobRow && bobRow.attempts >= 1, `bob still pending after ${bobRow?.attempts} attempt(s)`);
    await mock('POST', '/admin/block', { member: 'bob', blocked: false });
    check(await waitFor(async () => (await pendingCount()) === 0, 40_000),
      'bob notified once his address works again');
    const late = await api('POST', `/workshops/${ws.id}/registrations`, { memberId: 'henry' });
    check(late.status === 409, 'registering for a cancelled workshop is rejected');

    // 6 ─────────────────────────────────────────────────────────────
    step('6. No duplicates reached members');
    const all = (await api('GET', '/notifications')).body;
    const d = (await mock('GET', '/deliveries')).body;
    check(d.count === all.length,
      `${all.length} notifications owed, ${d.count} unique deliveries received`);
    console.log(`  ${d.duplicatesIgnored} retried request(s) were recognised as duplicates ` +
      'via the idempotency key and dropped');
  } catch (err) {
    console.error(err);
    failures++;
  } finally {
    apiProc?.kill('SIGKILL');
    mockProc?.kill('SIGKILL');
    for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) fs.rmSync(f, { force: true });
  }
  console.log(failures ? `\n\x1b[31m${failures} check(s) failed\x1b[0m`
                       : '\n\x1b[32mAll checks passed.\x1b[0m');
  process.exit(failures ? 1 : 0);
})();
