// Reminder rules: who is due and with which wording. Pure functions, no database.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres@localhost:5432/crm_test';
process.env.EMAIL_PROVIDER = 'mock';
const test = require('node:test');
const assert = require('node:assert');
const { dueInfo, segmentOf, inSendWindow, TEMPLATES, MAX_REMINDERS } = require('../src/services/gmdssReminders');

const DAY = 86400000;
const now = new Date('2026-11-12T10:00:00Z');
const base = (o = {}) => ({
  email: 'a@b.com', emailStatus: 'sent', lastEmailedAt: new Date(+now - 10 * DAY), repliedAt: null, bouncedAt: null,
  reminderCount: 0, lastReminderAt: null, openCount: 0, clickCount: 0, ...o,
});

test('segment follows clicks, then opens', () => {
  assert.equal(segmentOf(base({ clickCount: 1, openCount: 4 })), 'hot');
  assert.equal(segmentOf(base({ openCount: 2 })), 'warm');
  assert.equal(segmentOf(base()), 'cold');
});

test('waits 3 days for every segment', () => {
  const sent = (days) => new Date(+now - days * DAY);
  assert.ok(dueInfo(base({ clickCount: 1, lastEmailedAt: sent(3) }), now));
  assert.equal(dueInfo(base({ clickCount: 1, lastEmailedAt: sent(2.9) }), now), null);
  assert.ok(dueInfo(base({ openCount: 1, lastEmailedAt: sent(3) }), now));
  assert.equal(dueInfo(base({ openCount: 1, lastEmailedAt: sent(2.9) }), now), null);
  assert.ok(dueInfo(base({ lastEmailedAt: sent(3) }), now));
  assert.equal(dueInfo(base({ lastEmailedAt: sent(2.9) }), now), null);
});

test('the wait restarts from the last reminder', () => {
  const l = base({ reminderCount: 1, lastReminderAt: new Date(+now - 2 * DAY) });
  assert.equal(dueInfo(l, now), null);
  assert.equal(dueInfo({ ...l, lastReminderAt: new Date(+now - 8 * DAY) }, now).n, 2);
});

test('stops on reply, bounce, cap, no email or never sent', () => {
  assert.equal(dueInfo(base({ repliedAt: now }), now), null);
  assert.equal(dueInfo(base({ bouncedAt: now }), now), null);
  assert.equal(dueInfo(base({ reminderCount: MAX_REMINDERS }), now), null);
  assert.equal(dueInfo(base({ email: null }), now), null);
  assert.equal(dueInfo(base({ emailStatus: 'not_sent', lastEmailedAt: null }), now), null);
});

test('send window: Sun-Thu 09-17 Israel time', () => {
  assert.equal(inSendWindow(new Date('2026-11-12T10:00:00Z')), true); // Thu 12:00 IST
  assert.equal(inSendWindow(new Date('2026-11-12T16:00:00Z')), false); // Thu 18:00 IST
  assert.equal(inSendWindow(new Date('2026-11-13T09:00:00Z')), false); // Fri
  assert.equal(inSendWindow(new Date('2026-11-14T09:00:00Z')), false); // Sat
  assert.equal(inSendWindow(new Date('2026-11-15T09:00:00Z')), true); // Sun
});

test('every segment has a template for every reminder', () => {
  for (const s of ['hot', 'warm', 'cold']) assert.equal(TEMPLATES[s].length, MAX_REMINDERS);
});
