// Background dispatcher: reads due rows from the notifications outbox and
// delivers them to the notification service, retrying failures with
// exponential backoff. Runs inside the API process but is fully decoupled
// from requests: the API only writes rows, this loop only reads them.

function createDispatcher(db, opts) {
  const {
    notifierUrl,
    pollMs = 250,
    batchSize = 50,
    requestTimeoutMs = 1500,
    baseBackoffMs = 500,
    maxBackoffMs = 30_000,
    log = () => {},
  } = opts;

  const claim = db.prepare(`
    SELECT id, idempotency_key, payload, attempts FROM notifications
    WHERE status = 'pending' AND next_attempt_at <= ?
    ORDER BY next_attempt_at LIMIT ?`);
  // Lease: push next_attempt_at into the future while a send is in flight.
  // If the process dies mid-send, the lease simply expires and the row is
  // picked up again after restart. Nothing is ever "stuck".
  const lease = db.prepare('UPDATE notifications SET next_attempt_at = ? WHERE id = ?');
  const markSent = db.prepare(`
    UPDATE notifications SET status = 'sent', sent_at = ?, attempts = attempts + 1,
      last_error = NULL WHERE id = ?`);
  const markFailed = db.prepare(`
    UPDATE notifications SET attempts = attempts + 1, last_error = ?, next_attempt_at = ?
    WHERE id = ?`);

  function backoff(attempts) {
    const exp = Math.min(maxBackoffMs, baseBackoffMs * 2 ** attempts);
    return exp / 2 + Math.random() * (exp / 2); // jitter avoids retry storms
  }

  async function send(row) {
    try {
      const res = await fetch(notifierUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Same key on every retry, so the receiver can drop duplicates.
          'idempotency-key': row.idempotency_key,
        },
        body: row.payload,
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (res.ok) {
        markSent.run(Date.now(), row.id);
        log(`sent      ${row.idempotency_key}`);
        return;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      const reason = err.name === 'TimeoutError' ? 'timeout' : err.cause?.code || err.message;
      const wait = backoff(row.attempts);
      markFailed.run(reason, Date.now() + wait, row.id);
      log(`retry     ${row.idempotency_key} (${reason}, attempt ${row.attempts + 1}, ` +
          `next in ${Math.round(wait)}ms)`);
    }
  }

  let timer = null;
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const now = Date.now();
      const rows = claim.all(now, batchSize);
      for (const r of rows) lease.run(now + requestTimeoutMs * 2, r.id);
      // Send in parallel: one slow or failing member never blocks the rest.
      await Promise.allSettled(rows.map(send));
    } catch (err) {
      log(`dispatcher error: ${err.message}`);
    } finally {
      running = false;
    }
  }

  return {
    start() { timer = setInterval(tick, pollMs); tick(); },
    stop() { clearInterval(timer); },
    tick,
  };
}

module.exports = { createDispatcher };
