// Business logic. Each operation that owes someone a notification writes the
// notification row in the same transaction as the change itself, so the two
// can never disagree: either both are saved or neither is.
const { tx } = require('./db');

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function createService(db) {
  const now = () => Date.now();

  const q = {
    insertWorkshop: db.prepare(
      'INSERT INTO workshops (title, starts_at, capacity, created_at) VALUES (?, ?, ?, ?)'),
    getWorkshop: db.prepare('SELECT * FROM workshops WHERE id = ?'),
    countRegs: db.prepare('SELECT COUNT(*) AS n FROM registrations WHERE workshop_id = ?'),
    insertReg: db.prepare(
      'INSERT INTO registrations (workshop_id, member_id, created_at) VALUES (?, ?, ?)'),
    findReg: db.prepare('SELECT id FROM registrations WHERE workshop_id = ? AND member_id = ?'),
    listRegs: db.prepare('SELECT member_id FROM registrations WHERE workshop_id = ? ORDER BY id'),
    cancelWorkshop: db.prepare("UPDATE workshops SET status = 'cancelled' WHERE id = ?"),
    insertNotification: db.prepare(`
      INSERT INTO notifications
        (idempotency_key, type, workshop_id, member_id, payload, next_attempt_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (idempotency_key) DO NOTHING`),
  };

  function enqueue(key, type, workshop, memberId, message) {
    const payload = JSON.stringify({
      to: memberId, type, workshopId: workshop.id, workshopTitle: workshop.title, message,
    });
    q.insertNotification.run(key, type, workshop.id, memberId, payload, now(), now());
  }

  function requireWorkshop(id) {
    const w = q.getWorkshop.get(Number(id));
    if (!w) throw new HttpError(404, 'not_found', `Workshop ${id} not found`);
    return w;
  }

  return {
    createWorkshop({ title, startsAt = null, capacity = null }) {
      if (!title || typeof title !== 'string') {
        throw new HttpError(400, 'invalid', 'title is required');
      }
      if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1)) {
        throw new HttpError(400, 'invalid', 'capacity must be a positive integer');
      }
      const r = q.insertWorkshop.run(title, startsAt, capacity, now());
      return q.getWorkshop.get(r.lastInsertRowid);
    },

    getWorkshop(id) {
      const w = requireWorkshop(id);
      return { ...w, registered: q.listRegs.all(w.id).map((r) => r.member_id) };
    },

    register(workshopId, memberId) {
      if (!memberId || typeof memberId !== 'string') {
        throw new HttpError(400, 'invalid', 'memberId is required');
      }
      // All checks + both inserts happen in one transaction. If anything
      // fails, nothing is written, so a failed registration can never
      // leave a confirmation behind.
      return tx(db, () => {
        const w = requireWorkshop(workshopId);
        if (w.status === 'cancelled') {
          throw new HttpError(409, 'cancelled', 'Workshop is cancelled');
        }
        if (q.findReg.get(w.id, memberId)) {
          throw new HttpError(409, 'already_registered', `${memberId} is already registered`);
        }
        if (w.capacity !== null && q.countRegs.get(w.id).n >= w.capacity) {
          throw new HttpError(409, 'full', 'Workshop is full');
        }
        const r = q.insertReg.run(w.id, memberId, now());
        const registrationId = Number(r.lastInsertRowid);
        enqueue(`confirm:${registrationId}`, 'confirmation', w, memberId,
          `You're registered for "${w.title}".`);
        return { registrationId, workshopId: w.id, memberId, confirmation: 'queued' };
      });
    },

    cancel(workshopId) {
      return tx(db, () => {
        const w = requireWorkshop(workshopId);
        if (w.status === 'cancelled') {
          throw new HttpError(409, 'cancelled', 'Workshop is already cancelled');
        }
        q.cancelWorkshop.run(w.id);
        // One independent notification per member, so a failure for one
        // member never holds up the others.
        const members = q.listRegs.all(w.id).map((r) => r.member_id);
        for (const m of members) {
          enqueue(`cancel:${w.id}:${m}`, 'cancellation', w, m,
            `"${w.title}" has been cancelled.`);
        }
        return { workshopId: w.id, status: 'cancelled', notificationsQueued: members.length };
      });
    },

    listNotifications(status) {
      const rows = status
        ? db.prepare('SELECT * FROM notifications WHERE status = ? ORDER BY id').all(status)
        : db.prepare('SELECT * FROM notifications ORDER BY id').all();
      return rows.map(({ payload, ...rest }) => rest);
    },

    stats() {
      const rows = db.prepare(
        'SELECT status, COUNT(*) AS n FROM notifications GROUP BY status').all();
      const out = { pending: 0, sent: 0 };
      for (const r of rows) out[r.status] = r.n;
      return out;
    },
  };
}

module.exports = { createService, HttpError };
