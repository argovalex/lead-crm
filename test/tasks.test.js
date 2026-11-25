const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma, reset } = require('./helpers');
const leads = require('../src/services/leads');
const tasks = require('../src/services/tasks');
const { createApp } = require('../src/app');

const DAY = 86400000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

beforeEach(async () => {
  await reset();
  await prisma.$executeRawUnsafe('TRUNCATE "Task" RESTART IDENTITY CASCADE');
});
after(async () => { await prisma.$disconnect(); });

const mkLead = (over = {}) => leads.createLead({ name: 'Dana Levi', email: 'dana@example.com', company: 'Acme Marine', country: 'Israel', ...over });
const mk = (leadId, over = {}) => tasks.createTask(leadId, { title: 'Call Dana', taskType: 'PHONE_CALL', dueDate: iso(1), priority: 'A', ...over });

test('multiple tasks per lead, each with its own fields', async () => {
  const l = await mkLead();
  const a = await mk(l.id);
  const b = await mk(l.id, { title: 'Send proposal', taskType: 'SEND_PROPOSAL', priority: 'B', dueTime: '10:30', description: 'PDF v2' });
  const c = await mk(l.id, { title: 'Demo', taskType: 'PRODUCT_DEMO', priority: 'C' });
  assert.equal(new Set([a.id, b.id, c.id]).size, 3);
  const rows = await prisma.task.findMany({ where: { leadId: l.id } });
  assert.equal(rows.length, 3);
  assert.equal(rows.find((t) => t.id === b.id).dueTime, '10:30');
  assert.ok(rows.every((t) => t.createdAt && t.completedAt === null && t.status === 'OPEN'));
  const created = await prisma.activity.count({ where: { leadId: l.id, type: 'TASK_CREATED' } });
  assert.equal(created, 3);
});

test('validation: type, priority, status, time, date', async () => {
  const l = await mkLead();
  await assert.rejects(() => mk(l.id, { taskType: 'NOPE' }), /invalid_task_type/);
  await assert.rejects(() => mk(l.id, { priority: 'Z' }), /invalid_priority/);
  await assert.rejects(() => mk(l.id, { dueTime: '25:99' }), /invalid_time/);
  await assert.rejects(() => mk(l.id, { dueDate: 'garbage' }), /invalid_date/);
  await assert.rejects(() => mk(l.id, { title: '  ' }), /title_required/);
});

test('only one active Next Action per lead; replace and set-next move the flag; mirror stays on the lead', async () => {
  const l = await mkLead();
  const a = await mk(l.id, { isNextAction: true, title: 'Call Dana' });
  await assert.rejects(() => mk(l.id, { isNextAction: true, title: 'Other' }), /next_action_exists/);
  let lead = await prisma.lead.findUnique({ where: { id: l.id } });
  assert.equal(lead.nextAction, 'Call Dana');
  assert.equal(lead.nextFollowUpAt.toISOString().slice(0, 10), iso(1));

  const b = await mk(l.id, { title: 'Meeting', taskType: 'MEETING', dueDate: iso(3) });
  await tasks.setNextAction(b.id);
  const flags = await prisma.task.findMany({ where: { leadId: l.id, isNextAction: true } });
  assert.deepEqual(flags.map((t) => t.id), [b.id]);
  lead = await prisma.lead.findUnique({ where: { id: l.id } });
  assert.equal(lead.nextAction, 'Meeting');

  // the database itself refuses a second active next action
  await assert.rejects(() => prisma.task.update({ where: { id: a.id }, data: { isNextAction: true } }));
  const c = await mk(l.id, { title: 'Replace', isNextAction: true, replaceNext: true });
  const now = await prisma.task.findMany({ where: { leadId: l.id, isNextAction: true } });
  assert.deepEqual(now.map((t) => t.id), [c.id]);
});

test('complete: sets completedAt, keeps history, never closes the lead; optional next action created in the same transaction', async () => {
  const l = await mkLead();
  const a = await mk(l.id, { isNextAction: true });
  const r = await tasks.completeTask(a.id, { next: { title: 'Follow up', taskType: 'FOLLOWUP_EMAIL', dueDate: iso(5), isNextAction: true } });
  assert.equal(r.task.status, 'COMPLETED');
  assert.ok(r.task.completedAt);
  assert.equal(r.next.isNextAction, true);
  const lead = await prisma.lead.findUnique({ where: { id: l.id } });
  assert.equal(lead.stage, 'NEW', 'completing a task does not move or close the lead');
  assert.equal(lead.nextAction, 'Follow up');
  assert.equal(await prisma.task.count({ where: { leadId: l.id } }), 2, 'completed task preserved');
  // completing twice does not duplicate timeline events
  await tasks.completeTask(a.id);
  assert.equal(await prisma.activity.count({ where: { leadId: l.id, type: 'TASK_COMPLETED' } }), 1);
  // completed tasks cannot be deleted
  await assert.rejects(() => tasks.deleteTask(a.id), /completed_preserved/);
});

test('complete without next: lead mirror cleared and lead appears in "no next action"', async () => {
  const l = await mkLead();
  const a = await mk(l.id, { isNextAction: true });
  await tasks.completeTask(a.id);
  const lead = await prisma.lead.findUnique({ where: { id: l.id } });
  assert.equal(lead.nextFollowUpAt, null);
  assert.equal((await tasks.summary()).noNextAction, 1);
  assert.deepEqual((await tasks.leadsWithoutNext()).map((x) => x.id), [l.id]);
});

test('reschedule logs a follow-up date change once and updates the mirror', async () => {
  const l = await mkLead();
  const a = await mk(l.id, { isNextAction: true });
  await tasks.rescheduleTask(a.id, { dueDate: iso(9), dueTime: '08:00' });
  const t = await prisma.task.findUnique({ where: { id: a.id } });
  assert.equal(t.dueTime, '08:00');
  assert.equal(t.dueDate.toISOString().slice(0, 10), iso(9));
  assert.equal(await prisma.activity.count({ where: { leadId: l.id, type: 'FOLLOWUP_DATE_CHANGED' } }), 1);
  await tasks.rescheduleTask(a.id, { dueDate: iso(9) }); // same day: no new event
  assert.equal(await prisma.activity.count({ where: { leadId: l.id, type: 'FOLLOWUP_DATE_CHANGED' } }), 1);
  const lead = await prisma.lead.findUnique({ where: { id: l.id } });
  assert.equal(lead.nextFollowUpAt.toISOString().slice(0, 10), iso(9));
});

test('overdue detection: past date and still active; completed and cancelled are never overdue', async () => {
  const l = await mkLead();
  const past = await mk(l.id, { title: 'old', dueDate: iso(-3) });
  const done = await mk(l.id, { title: 'old done', dueDate: iso(-3) });
  const cancelled = await mk(l.id, { title: 'old cancelled', dueDate: iso(-3) });
  await mk(l.id, { title: 'today', dueDate: iso(0) });
  await mk(l.id, { title: 'soon', dueDate: iso(4) });
  await mk(l.id, { title: 'later', dueDate: iso(30) });
  await tasks.completeTask(done.id);
  await tasks.updateTask(cancelled.id, { status: 'CANCELLED' });
  const s = await tasks.summary();
  assert.equal(s.overdue, 1);
  assert.equal(s.today, 1);
  assert.equal(s.week, 2, 'next 7 days including today');
  const over = await tasks.listTasks({ view: 'overdue' });
  assert.deepEqual(over.map((t) => t.id), [past.id]);
  assert.equal(over[0].bucket, 'overdue');
  const doneList = await tasks.listTasks({ view: 'completed' });
  assert.deepEqual(doneList.map((t) => t.id), [done.id]);
});

test('waiting view, filters, search and sorting', async () => {
  const a = await mkLead();
  const b = await mkLead({ email: 'b@example.com', name: 'Bob', company: 'Zeta Shipping', country: 'Greece', segment: 'Shipping' });
  const t1 = await mk(a.id, { title: 'alpha call', dueDate: iso(2) });
  const t2 = await mk(b.id, { title: 'beta mail', taskType: 'FOLLOWUP_EMAIL', priority: 'C', dueDate: iso(1), status: 'WAITING' });
  assert.deepEqual((await tasks.listTasks({ view: 'waiting' })).map((t) => t.id), [t2.id]);
  assert.deepEqual((await tasks.listTasks({ country: 'Greece' })).map((t) => t.id), [t2.id]);
  assert.deepEqual((await tasks.listTasks({ leadType: 'Shipping' })).map((t) => t.id), [t2.id]);
  assert.deepEqual((await tasks.listTasks({ priority: 'A' })).map((t) => t.id), [t1.id]);
  assert.deepEqual((await tasks.listTasks({ taskType: 'FOLLOWUP_EMAIL' })).map((t) => t.id), [t2.id]);
  assert.deepEqual((await tasks.listTasks({ org: 'zeta' })).map((t) => t.id), [t2.id]);
  assert.deepEqual((await tasks.listTasks({ q: 'alpha' })).map((t) => t.id), [t1.id]);
  assert.deepEqual((await tasks.listTasks({ sort: 'due' })).map((t) => t.id), [t2.id, t1.id]);
  assert.deepEqual((await tasks.listTasks({ sort: 'due', dir: 'desc' })).map((t) => t.id), [t1.id, t2.id]);
  assert.deepEqual((await tasks.listTasks({ sort: 'org' })).map((t) => t.id), [t1.id, t2.id]);
});

test('dedupeKey prevents duplicate tasks (e.g. follow-up offered after a send)', async () => {
  const l = await mkLead();
  const a = await mk(l.id, { dedupeKey: 'followup:msg:7' });
  const b = await mk(l.id, { dedupeKey: 'followup:msg:7' });
  assert.equal(b.duplicate, true);
  assert.equal(a.id, b.id);
  assert.equal(await prisma.task.count({ where: { leadId: l.id } }), 1);
  assert.equal(await prisma.activity.count({ where: { leadId: l.id, type: 'TASK_CREATED' } }), 1);
});

test('existing flows: manual outreach creates one Next Action task; re-import and replay never duplicate it', async () => {
  const sentAt = new Date(Date.now() - 2 * DAY).toISOString();
  const r = await leads.logInteractionByEmail({ email: 'new@acme.com', name: 'New', kind: 'EMAIL_OUT', subject: 'Hi', body: 'x', at: sentAt });
  let rows = await prisma.task.findMany({ where: { leadId: r.leadId } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].isNextAction, true);
  assert.equal(rows[0].title, 'מעקב');
  assert.equal(rows[0].dueDate.toISOString().slice(0, 10), new Date(new Date(sentAt).getTime() + 5 * DAY).toISOString().slice(0, 10), 'five-day follow-up unchanged');
  await leads.logInteraction(r.leadId, { kind: 'EMAIL_OUT', subject: 'Hi', body: 'x', at: sentAt });
  await leads.logInteraction(r.leadId, { kind: 'EMAIL_OUT', subject: 'Hi', body: 'x', at: sentAt });
  rows = await prisma.task.findMany({ where: { leadId: r.leadId } });
  assert.equal(rows.length, 1, 'still one task');
  // a backfilled older mail leaves reminders alone
  await leads.logInteraction(r.leadId, { kind: 'EMAIL_OUT', at: new Date(Date.now() - 20 * DAY).toISOString(), backfill: true });
  assert.equal(await prisma.task.count({ where: { leadId: r.leadId } }), 1);
});

test('received reply: lead flagged for review, reply task created, lead stays open', async () => {
  const l = await mkLead();
  await leads.logInteraction(l.id, { kind: 'EMAIL_OUT', subject: 'Hi', at: new Date(Date.now() - 3 * DAY).toISOString() });
  await leads.logInteraction(l.id, { kind: 'EMAIL_IN', subject: 'Re: Hi', body: 'interested' });
  const lead = await prisma.lead.findUnique({ where: { id: l.id } });
  assert.equal(lead.replied, true);
  assert.notEqual(lead.stage, 'WON');
  assert.notEqual(lead.stage, 'LOST');
  const next = await prisma.task.findFirst({ where: { leadId: l.id, isNextAction: true, status: 'OPEN' } });
  assert.equal(next.title, 'להשיב');
  assert.equal((await tasks.summary()).needsReview, 1);
});

test('closing a lead cancels (keeps) its tasks and hides them from the dashboard', async () => {
  const l = await mkLead();
  await mk(l.id, { isNextAction: true });
  await require('../src/services/gmdss').closeEverywhere(prisma, [l.email], { closed: true, reason: 'no budget' });
  const rows = await prisma.task.findMany({ where: { leadId: l.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'CANCELLED');
  assert.equal((await tasks.listTasks({})).length, 0);
});

test('HTTP API: auth + csrf, create, list, complete with next, reschedule, delete', async () => {
  const app = createApp();
  const agent = request.agent(app);
  assert.equal((await agent.get('/api/tasks')).status, 401);
  await agent.post('/auth/login').send({ email: 'admin@test.dev', password: 'correct-horse-battery' }).expect(200);
  const { csrf } = (await agent.get('/auth/me')).body;
  const l = await mkLead();
  await agent.post('/api/tasks').send({ leadId: l.id, title: 'x', dueDate: iso(1) }).expect(403);
  const created = await agent.post('/api/tasks').set('x-csrf-token', csrf).send({ leadId: l.id, title: 'Call', taskType: 'PHONE_CALL', dueDate: iso(-1), isNextAction: true }).expect(201);
  const dup = await agent.post('/api/tasks').set('x-csrf-token', csrf).send({ leadId: l.id, title: 'Second next', dueDate: iso(2), isNextAction: true });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error, 'next_action_exists');
  const list = await agent.get('/api/tasks?view=overdue').expect(200);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].lead.company, 'Acme Marine');
  assert.equal((await agent.get('/api/tasks/summary').expect(200)).body.overdue, 1);
  await agent.post(`/api/tasks/${created.body.id}/reschedule`).set('x-csrf-token', csrf).send({ dueDate: iso(4) }).expect(200);
  assert.equal((await agent.get('/api/tasks/summary')).body.overdue, 0);
  const done = await agent.post(`/api/tasks/${created.body.id}/complete`).set('x-csrf-token', csrf).send({ next: { title: 'Then', dueDate: iso(6), isNextAction: true } }).expect(200);
  assert.equal(done.body.task.status, 'COMPLETED');
  assert.equal((await agent.get(`/api/leads/${l.id}/tasks`).expect(200)).body.length, 2);
  await agent.delete(`/api/tasks/${created.body.id}`).set('x-csrf-token', csrf).expect(409);
  await agent.delete(`/api/tasks/${done.body.next.id}`).set('x-csrf-token', csrf).expect(204);
  assert.equal((await prisma.lead.findUnique({ where: { id: l.id } })).nextFollowUpAt, null);
});

test('mail sent from the GMDSS card appears on the main lead timeline once', async () => {
  const l = await mkLead({ email: 'gm@example.com' });
  await prisma.gmdssLead.deleteMany({ where: { email: 'gm@example.com' } });
  const gl = await prisma.gmdssLead.create({ data: { organization: 'GM Org', email: 'gm@example.com' } });
  await prisma.gmdssActivity.create({ data: { leadId: gl.id, type: 'reply_sent', detail: 'Re: quote\nThanks, attached.' } });
  const { syncSentToMainLead } = require('../src/services/gmdss');
  assert.equal(await syncSentToMainLead(prisma, l.id), 1);
  assert.equal(await syncSentToMainLead(prisma, l.id), 0);
  const acts = await prisma.activity.findMany({ where: { leadId: l.id, type: 'MANUAL_EMAIL_OUT' } });
  assert.equal(acts.length, 1);
  assert.equal(acts[0].data.subject, 'Re: quote');
  assert.equal(acts[0].data.body, 'Thanks, attached.');
  await prisma.gmdssLead.deleteMany({ where: { email: 'gm@example.com' } });
});

test('mail sent from the GMDSS card settles an overdue reminder on the main lead', async () => {
  const l = await mkLead({ email: 'od@example.com' });
  await prisma.lead.update({ where: { id: l.id }, data: { nextAction: 'מעקב', nextFollowUpAt: new Date(Date.now() - 3 * DAY) } });
  await tasks.reconcileFromLead(l.id, prisma);
  await prisma.gmdssLead.deleteMany({ where: { email: 'od@example.com' } });
  const gl = await prisma.gmdssLead.create({ data: { organization: 'OD Org', email: 'od@example.com' } });
  const sentAt = new Date(Date.now() - DAY);
  await prisma.gmdssActivity.create({ data: { leadId: gl.id, type: 'reply_sent', detail: 'Re: x\nbody', createdAt: sentAt } });
  const { syncSentToMainAll } = require('../src/services/gmdss');
  await syncSentToMainAll(prisma, { force: true });
  const after = await prisma.lead.findUnique({ where: { id: l.id } });
  assert.ok(after.nextFollowUpAt > new Date(), 'follow-up moved to the future');
  const next = await prisma.task.findFirst({ where: { leadId: l.id, isNextAction: true, status: { in: ['OPEN', 'IN_PROGRESS', 'WAITING'] } } });
  assert.ok(next && next.dueDate > new Date(Date.now() - DAY), 'next action task is no longer overdue');
  await syncSentToMainAll(prisma, { force: true });
  assert.equal((await prisma.activity.count({ where: { leadId: l.id, type: 'MANUAL_EMAIL_OUT' } })), 1);
  await prisma.gmdssLead.deleteMany({ where: { email: 'od@example.com' } });
});
