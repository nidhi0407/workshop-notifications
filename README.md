# Workshop Registration & Notifications

A workshop registration backend plus a deliberately unreliable mock notification service. Every successful registration eventually produces exactly one confirmation, even if the notifier is failing, timing out, or the backend crashes halfway through.

**Zero dependencies.** Plain Node.js, using the built-in `node:http` and `node:sqlite`. No `npm install` needed.

## Quick start

Requires **Node.js 22.13 or newer** (`node --version`).

```bash
npm run demo        # starts everything and runs the full scenario with checks
```

To run the pieces yourself, use two terminals:

```bash
npm run mock        # mock notifier on :4000 (25% errors, 10% lost responses)
npm start           # API on :3000, data stored in ./data.db
```

Then try it:

```bash
curl -X POST localhost:3000/workshops -H 'content-type: application/json' \
     -d '{"title":"Intro to Go","capacity":30}'
curl -X POST localhost:3000/workshops/1/registrations -H 'content-type: application/json' \
     -d '{"memberId":"alice"}'
curl localhost:3000/notifications
curl -X POST localhost:3000/workshops/1/cancel
```

Environment variables: `PORT`, `DB_FILE`, `NOTIFIER_URL` (API); `PORT`, `FAIL_RATE`, `TIMEOUT_RATE` (mock).

## API

| Method | Path | Result |
|---|---|---|
| `POST` | `/workshops` | Create a workshop. Body: `{ title, startsAt?, capacity? }` → `201` |
| `GET` | `/workshops/:id` | Workshop details and registered members |
| `POST` | `/workshops/:id/registrations` | Body: `{ memberId }` → `201`, or `409` with `already_registered`, `full` or `cancelled` |
| `POST` | `/workshops/:id/cancel` | Cancel and notify every registered member |
| `GET` | `/notifications?status=pending\|sent` | The outbox: what is owed, attempts, last error |
| `GET` | `/health` | Pending / sent counts |

Mock notifier: `POST /notify` (needs an `Idempotency-Key` header), plus demo controls `GET /deliveries`, `POST /admin/outage`, `POST /admin/block`, `POST /admin/rates`.

## Demonstration

`npm run demo` starts both services and proves each requirement, failing if any check doesn't hold. A saved run is in [`docs/demo-output.txt`](docs/demo-output.txt).

1. **Registration returns immediately.** The response arrives in a few milliseconds and says the confirmation is *queued*. The API never calls the notifier itself.
2. **Failed registrations produce nothing.** A duplicate registration and a registration for a full workshop are both rejected, and no confirmation exists for them.
3. **Retries.** With 25% random errors and 10% lost responses, all confirmations still get through.
4. **Crash recovery.** The notifier is taken down, three members register, and the API is killed with `SIGKILL`. After a restart, all three confirmations are delivered.
5. **Cancellation and isolation.** One member's address is made to fail permanently. A workshop is cancelled: the other members are notified right away while that member keeps retrying, and is notified once the address works again.
6. **No duplicates.** The number of unique deliveries the notifier received equals the number of notifications owed, even though some requests were retried after a delivery succeeded but its response was lost.

## Design

```
            ┌──────────── one SQLite transaction ─────────────┐
POST /register → │ INSERT registration  +  INSERT notification (outbox) │ → 201 "queued"
            └─────────────────────────────────────────────────┘
                                       │
              dispatcher (polls every 250ms)
                                       │  POST /notify  (Idempotency-Key: confirm:12)
                                       ▼
                             mock notifier ── 200 → mark sent
                                           ── 503 / timeout → retry later with backoff
```

### Transactional outbox

The core idea: **the API never sends notifications. It writes them down.** When a registration succeeds, the registration row and a `notifications` row are inserted in the *same database transaction*. So there are only two possible outcomes:

- The transaction commits, and both the registration and the debt to notify are durably on disk.
- It fails (duplicate, full, cancelled, any error), and neither exists.

That is why a failed registration can never produce a confirmation, and a successful one can never be "forgotten". A separate dispatcher loop reads due rows from the outbox and delivers them. Because it is decoupled from the request, the user gets their response without waiting on the notifier.

### How each failure case is handled

**Lost notifications.** A notification only leaves the outbox when the notifier returns a success response. Errors, timeouts, connection refusals and crashes all leave the row `pending`, so it is retried. Nothing is held only in memory.

**Retries.** Failed sends are rescheduled with exponential backoff (0.5s, 1s, 2s … capped at 30s) plus random jitter, so a recovering notifier is not flooded by every retry at once. Retries never give up, since the brief requires that every registration *eventually* gets its confirmation. The `attempts` and `last_error` columns make stuck notifications visible through `GET /notifications?status=pending`.

**One member's failure doesn't block others.** Each member gets their own outbox row with its own retry schedule, and each dispatcher batch is sent in parallel with `Promise.allSettled`. A member whose sends keep failing just moves further back in their own schedule. Cancellation creates one row per member for this reason, rather than one "notify everyone" job.

**Duplicate delivery.** Retrying creates a real risk: the notifier may deliver a message and then the response gets lost (the mock simulates exactly this). From the sender's side that looks like a failure, so it retries. To make this safe, every notification has a stable **idempotency key** (`confirm:<registrationId>` or `cancel:<workshopId>:<memberId>`) sent as a header on every attempt. The notifier remembers keys it has delivered and answers repeats with success without sending again. The same key is `UNIQUE` in the outbox, so a notification can't be queued twice either. Together this gives *at-least-once sending, exactly-once delivery*.

**Backend restarts.** All state is in SQLite with `synchronous = FULL`, so a registration is on disk before `201` is returned. If the process dies:
- *Before commit:* the transaction rolls back. No registration and no confirmation, and the client got an error.
- *After commit, before sending:* the row is `pending`. The dispatcher finds it on startup.
- *During a send:* while a request is in flight its `next_attempt_at` is pushed forward as a short lease. If the process dies, the lease expires and the row is retried after restart. If that send had actually been delivered, the idempotency key stops the second one.

There is no state that only exists in memory, so there is nothing for a crash to lose.

**Double registration.** Enforced by a `UNIQUE (workshop_id, member_id)` constraint in the database, not just an application check, so it holds even under concurrent requests.

## Trade-offs and limitations

- **SQLite, single process.** Simple and fully durable, and plenty for a campus club. To run several API instances, the same design moves to Postgres, where dispatchers claim rows with `SELECT … FOR UPDATE SKIP LOCKED` instead of the lease column.
- **Polling.** The dispatcher polls every 250ms, which adds up to that much latency before the first send attempt. Fine for confirmations; a busier system could wake the dispatcher directly after a commit.
- **Idempotency relies on the receiver.** Real email/SMS providers usually accept an idempotency key. If one doesn't, the provider can't guarantee exactly-once, and at-least-once (a rare duplicate) is the best any sender can do.
- **Mock keeps its records in memory.** It stands in for an external provider, so its storage isn't part of this system.
- **No authentication.** Organizer and member endpoints are open. A real deployment would add auth.

## Project layout

```
src/db.js            schema and transaction helper
src/service.js       business rules: create, register, cancel (writes the outbox)
src/dispatcher.js    delivery loop: lease, send, retry with backoff
src/server.js        HTTP routing
mock/notifier.js     unreliable notification service with idempotency
scripts/demo.js      end-to-end demo and test suite
```
