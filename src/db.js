// Database setup. Uses Node's built-in SQLite (no external dependencies).
// SQLite gives us durable writes and real transactions, which is what the
// "survive a restart" requirement needs.
const { DatabaseSync } = require('node:sqlite');

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;      -- crash-safe, concurrent readers
    PRAGMA synchronous = FULL;      -- a committed row is on disk before we reply
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS workshops (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT    NOT NULL,
      starts_at   TEXT,
      capacity    INTEGER,                       -- NULL = unlimited
      status      TEXT    NOT NULL DEFAULT 'active',  -- active | cancelled
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS registrations (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      workshop_id  INTEGER NOT NULL REFERENCES workshops(id),
      member_id    TEXT    NOT NULL,
      created_at   INTEGER NOT NULL,
      UNIQUE (workshop_id, member_id)            -- one registration per member per workshop
    );

    -- Transactional outbox: every notification we owe someone is a row here,
    -- written in the SAME transaction as the business change that caused it.
    CREATE TABLE IF NOT EXISTS notifications (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key  TEXT    NOT NULL UNIQUE,  -- e.g. confirm:12  /  cancel:3:alice
      type             TEXT    NOT NULL,         -- confirmation | cancellation
      workshop_id      INTEGER NOT NULL,
      member_id        TEXT    NOT NULL,
      payload          TEXT    NOT NULL,         -- JSON body sent to the notifier
      status           TEXT    NOT NULL DEFAULT 'pending',  -- pending | sent
      attempts         INTEGER NOT NULL DEFAULT 0,
      next_attempt_at  INTEGER NOT NULL,         -- also acts as a lease while sending
      last_error       TEXT,
      created_at       INTEGER NOT NULL,
      sent_at          INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_due
      ON notifications (status, next_attempt_at);
  `);
  return db;
}

// Run fn inside BEGIN IMMEDIATE ... COMMIT, rolling back on any error.
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDb, tx };
