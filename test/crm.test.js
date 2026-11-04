const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { Webhook } = require('svix');
const request = require('supertest');
const { prisma, reset } = require('./helpers');
const leads = require('../src/services/leads');
const email = require('../src/services/email');
const scheduler = require('../src/services/scheduler');
const { createApp } = require('../src/app');

const DAY = email.DAY;
const T0 = new Date('2026-11-01T08:00:00Z');
const at = (days, extraMin = 0) => new Date(T0.getTime() + days * DAY + extraMin * 60000);

let mock;
beforeEach(async () => { mock = await reset(); });
after(async () => { await prisma.$disconnect(); });

async function seqAndLead(overrides = {}) {
  const lead = await leads.createLead({ name: 'Dana Levi', email: 'dana@example.com', company: 'Acme', ...overrides });
  const seq = await prisma.sequence.create({
    data: {
      name: 'Intro',
      steps: { create: [
        { index: 0, delayDays: 0, subject: 'Hi {{name}}', body: 'Hello {{name}} from {{company}}' },
        { index: 1, delayDays: 3, subject: 'Follow up', body: 'Bump {{name}}' },
        { index: 2, delayDays: 7, subject: 'Last one', body: 'Final' },
      ] },
    },
  });
  await email.enroll(lead.id, seq.id, T0);
  return { lead, seq };
}

test('sequence scheduling: steps sent on day 0, 3, 7 with variables; then completed', async () => {
  const { lead } = await seqAndLead();

  await scheduler.tick(at(0, 1));
  assert.equal(mock.sent.length, 1);
  assert.equal(mock.sent[0].subject, 'Hi Dana Levi');
  assert.match(mock.sent[0].text, /Hello Dana Levi from Acme/);
  assert.match(mock.sent[0].headers['List-Unsubscribe'], /https:\/\/crm\.test\/u\//);
  assert.equal(mock.sent[0].headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');

  await scheduler.tick(at(2, 59 * 24)); // just before day 3
  assert.equal(mock.sent.length, 1, 'no send before delay elapses');

  await scheduler.tick(at(3, 2));
  assert.equal(mock.sent.length, 2);
  assert.equal(mock.sent[1].subject, 'Follow up');

  await scheduler.tick(at(7, 5));
  assert.equal(mock.sent.length, 3);

  const enr = await prisma.enrollment.findFirst({ where: { leadId: lead.id } });
  assert.equal(enr.status, 'COMPLETED');
  const updated = await prisma.lead.findUnique({ where: { id: lead.id } });
  assert.equal(updated.stage, 'CONTACTED', 'auto-advanced from NEW on first send');

  await scheduler.tick(at(30));
  assert.equal(mock.sent.length, 3, 'nothing more after completion');
});

test('no duplicate sends after restart / overlapping ticks / crash mid-send', async () => {
  await seqAndLead();

  // Overlapping workers (two replicas, or a redeploy overlapping the old process).
  await Promise.all([
    email.materializeDueSteps(at(0, 1)), email.materializeDueSteps(at(0, 1)), email.materializeDueSteps(at(0, 1)),
  ]);
  assert.equal(await prisma.emailMessage.count(), 1, 'step materialized exactly once');

  await Promise.all([email.dispatch(at(0, 1)), email.dispatch(at(0, 1))]);
  assert.equal(mock.sent.length, 1, 'message dispatched exactly once');

  // Simulate a "restart": scheduler re-runs the same window repeatedly.
  for (let i = 0; i < 3; i += 1) await scheduler.tick(at(0, 2 + i));
  assert.equal(mock.sent.length, 1);

  // Crash mid-send: the process died after the provider accepted the email but before we marked it SENT.
  await scheduler.tick(at(3, 1)); // step 1 queued+sent normally
  assert.equal(mock.sent.length, 2);
  await email.materializeDueSteps(at(7, 1));
  const msg = await prisma.emailMessage.findFirst({ where: { stepIndex: 2 } });
  await mock.send({ to: 'dana@example.com', subject: 'Last one', idempotencyKey: msg.idempotencyKey }); // provider got it
  await prisma.emailMessage.update({ where: { id: msg.id }, data: { status: 'SENDING', lockedAt: at(7, 1) } }); // then crash
  await scheduler.tick(at(7, 5)); // < 10min: still considered in-flight, untouched
  assert.equal((await prisma.emailMessage.findUnique({ where: { id: msg.id } })).status, 'SENDING');
  await scheduler.tick(at(7, 20)); // recovered: retried with SAME idempotency key → provider dedupes
  assert.equal(mock.sent.length, 3, 'provider-side idempotency prevented a second copy');
  assert.equal((await prisma.emailMessage.findUnique({ where: { id: msg.id } })).status, 'SENT');
});

test('unsubscribe blocks all future sends (sequence + single) via one-click POST', async () => {
  const { lead } = await seqAndLead();
  const app = createApp();
  await scheduler.tick(at(0, 1));
  assert.equal(mock.sent.length, 1);

  const page = await request(app).get(`/u/${lead.unsubToken}`);
  assert.equal(page.status, 200);
  assert.equal((await prisma.lead.findUnique({ where: { id: lead.id } })).unsubscribed, false, 'GET alone does not unsubscribe');

  const r = await request(app).post(`/u/${lead.unsubToken}`).type('form').send('List-Unsubscribe=One-Click');
  assert.equal(r.status, 200);

  const l = await prisma.lead.findUnique({ where: { id: lead.id } });
  assert.equal(l.unsubscribed, true);
  assert.equal((await prisma.enrollment.findFirst({ where: { leadId: lead.id } })).status, 'STOPPED');

  await scheduler.tick(at(3, 1));
  await scheduler.tick(at(7, 1));
  assert.equal(mock.sent.length, 1, 'no further sequence emails');

  await assert.rejects(email.queueSingle(lead.id, 's', 'b'), /lead_unsubscribed/);
  await assert.rejects(email.enroll(lead.id, 999, at(8)), /lead_not_emailable/);

  // Even a message queued before unsubscribing is cancelled at dispatch time.
  await prisma.emailMessage.create({ data: { leadId: lead.id, subject: 'x', body: 'y', idempotencyKey: 'manual-x' } });
  await scheduler.tick(at(8));
  assert.equal(mock.sent.length, 1);
  assert.equal((await prisma.emailMessage.findUnique({ where: { idempotencyKey: 'manual-x' } })).status, 'CANCELLED');
});

test('reply stops the sequence and advances stage', async () => {
  const { lead } = await seqAndLead();
  await scheduler.tick(at(0, 1));
  assert.equal(mock.sent.length, 1);

  await leads.markReplied(lead.id, { now: at(1) });

  const enr = await prisma.enrollment.findFirst({ where: { leadId: lead.id } });
  assert.equal(enr.status, 'STOPPED');
  assert.equal(enr.stopReason, 'replied');
  assert.equal((await prisma.lead.findUnique({ where: { id: lead.id } })).stage, 'ENGAGED');

  await scheduler.tick(at(3, 1));
  await scheduler.tick(at(7, 1));
  assert.equal(mock.sent.length, 1);
});

test('inbound reply via signed webhook stops sequence', async () => {
  const { lead } = await seqAndLead();
  const app = createApp();
  const wh = new Webhook(process.env.WEBHOOK_SECRET);
  const payload = JSON.stringify({ type: 'email.received', data: { from: 'Dana <DANA@example.com>' } });
  const id = 'msg_inbound_1';
  const ts = new Date();
  const r = await request(app).post('/webhooks/email').set({
    'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': String(Math.floor(ts / 1000)), 'svix-signature': wh.sign(id, ts, payload),
  }).send(payload);
  assert.equal(r.status, 200);
  assert.equal((await prisma.enrollment.findFirst({ where: { leadId: lead.id } })).status, 'STOPPED');
});

test('webhook: invalid/missing signature rejected; valid events tracked once', async () => {
  const { lead } = await seqAndLead();
  const app = createApp();
  await scheduler.tick(at(0, 1));
  const msg = await prisma.emailMessage.findFirst();

  const payload = JSON.stringify({ type: 'email.opened', data: { email_id: msg.providerId } });
  const ts = new Date();
  const headers = (id, sig) => ({ 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': String(Math.floor(ts / 1000)), 'svix-signature': sig });

  const missing = await request(app).post('/webhooks/email').set('content-type', 'application/json').send(payload);
  assert.equal(missing.status, 401);

  const forged = new Webhook('whsec_' + Buffer.from('some-other-secret-32-bytes-long!').toString('base64'));
  const bad = await request(app).post('/webhooks/email').set(headers('evt_1', forged.sign('evt_1', ts, payload))).send(payload);
  assert.equal(bad.status, 401);
  assert.equal((await prisma.emailMessage.findUnique({ where: { id: msg.id } })).openedAt, null);

  const good = new Webhook(process.env.WEBHOOK_SECRET);
  const tampered = await request(app).post('/webhooks/email').set(headers('evt_1', good.sign('evt_1', ts, payload))).send(payload.replace('opened', 'clicked'));
  assert.equal(tampered.status, 401, 'body tampering detected');

  const ok = await request(app).post('/webhooks/email').set(headers('evt_1', good.sign('evt_1', ts, payload))).send(payload);
  assert.equal(ok.status, 200);
  assert.ok((await prisma.emailMessage.findUnique({ where: { id: msg.id } })).openedAt);

  const dup = await request(app).post('/webhooks/email').set(headers('evt_1', good.sign('evt_1', ts, payload))).send(payload);
  assert.equal(dup.body.duplicate, true);
  assert.equal(await prisma.activity.count({ where: { leadId: lead.id, type: 'EMAIL_OPENED' } }), 1);

  const bounce = JSON.stringify({ type: 'email.bounced', data: { email_id: msg.providerId } });
  await request(app).post('/webhooks/email').set(headers('evt_2', good.sign('evt_2', ts, bounce))).send(bounce);
  assert.equal((await prisma.enrollment.findFirst({ where: { leadId: lead.id } })).stopReason, 'bounced');
});

test('throttling: per-minute limit and daily cap', async () => {
  const config = require('../src/config');
  const orig = { ...config };
  config.sendsPerMinute = 2; config.dailySendCap = 3;
  try {
    for (let i = 0; i < 5; i += 1) {
      const l = await leads.createLead({ name: `L${i}`, email: `l${i}@ex.com` });
      await email.queueSingle(l.id, 'hi', 'there');
    }
    await email.dispatch(at(0, 1));
    assert.equal(mock.sent.length, 2);
    await email.dispatch(at(0, 2));
    assert.equal(mock.sent.length, 3, 'daily cap reached');
    const r = await email.dispatch(at(0, 3));
    assert.equal(r.capped, true);
    await email.dispatch(at(1, 1)); // next UTC day
    assert.equal(mock.sent.length, 5);
  } finally {
    config.sendsPerMinute = orig.sendsPerMinute; config.dailySendCap = orig.dailySendCap;
  }
});

test('CSV import dedupes by email (file + existing) and API requires auth + CSRF', async () => {
  await leads.createLead({ name: 'Existing', email: 'exist@ex.com' });
  const app = createApp();
  const agent = request.agent(app);

  assert.equal((await agent.get('/api/leads')).status, 401);
  assert.equal((await agent.post('/auth/login').send({ email: 'admin@test.dev', password: 'nope' })).status, 401);
  assert.equal((await agent.post('/auth/login').send({ email: 'ADMIN@test.dev', password: 'correct-horse-battery' })).status, 200);
  const { csrf } = (await agent.get('/auth/me')).body;

  const csv = '﻿שם,אימייל,חברה,תגיות\nA,a@ex.com,X,"vip,boat"\nA2,A@EX.com,X,\nE,exist@ex.com,,\nBad,not-an-email,,\n';
  assert.equal((await agent.post('/api/import').attach('file', Buffer.from(csv), 'l.csv')).status, 403, 'CSRF enforced');
  const r = await agent.post('/api/import').set('x-csrf-token', csrf).attach('file', Buffer.from(csv), 'l.csv');
  assert.equal(r.status, 200);
  assert.equal(r.body.created, 1);
  assert.equal(r.body.duplicates.length, 2);
  assert.equal(r.body.invalid.length, 1);
  const a = await prisma.lead.findUnique({ where: { email: 'a@ex.com' } });
  assert.deepEqual(a.tags, ['vip', 'boat']);

  const stats = await agent.get('/api/stats');
  assert.equal(stats.status, 200);
  assert.equal(stats.body.totalLeads, 2);
});

test('stale leads are flagged after N days without activity', async () => {
  const l = await leads.createLead({ name: 'Old', email: 'old@ex.com' });
  await prisma.lead.update({ where: { id: l.id }, data: { lastActivityAt: new Date(Date.now() - 30 * DAY) } });
  assert.equal(await email.flagStale(new Date()), 1);
  assert.equal(await email.flagStale(new Date()), 0, 'flagged once');
  await leads.logActivity(l.id, 'NOTE', { text: 'called' });
  assert.equal((await prisma.lead.findUnique({ where: { id: l.id } })).stale, false);
});
