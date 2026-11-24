// Tasks & follow-ups. A lead has at most one active "Next Action" task (isNextAction) plus any number
// of other tasks. Lead.nextAction / nextFollowUpAt mirror the Next Action so the existing "today" list,
// import and mail logic keep working; reconcileFromLead() goes the other way when that old code writes them.
const prisma = require('../db');

const TYPES = ['INITIAL_EMAIL', 'FOLLOWUP_EMAIL', 'PHONE_CALL', 'MEETING', 'SEND_PROPOSAL', 'PRODUCT_DEMO', 'NEGOTIATION', 'FINAL_DECISION', 'OTHER'];
const STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING', 'COMPLETED', 'CANCELLED'];
const ACTIVE = ['OPEN', 'IN_PROGRESS', 'WAITING'];
const PRIORITIES = ['A', 'B', 'C'];
const TZ = 'Asia/Jerusalem';

const bad = (code, status = 400) => Object.assign(new Error(code), { status });
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const dayKey = (d) => dayFmt.format(new Date(d)); // YYYY-MM-DD in Israel time
const addDays = (key, n) => dayKey(new Date(new Date(`${key}T12:00:00Z`).getTime() + n * 86400000));
const isActive = (t) => ACTIVE.includes(t.status);

// 'overdue' | 'today' | 'week' | 'later' | 'done'
function bucket(t, now = new Date()) {
  if (!isActive(t)) return 'done';
  const today = dayKey(now);
  const due = dayKey(t.dueDate);
  if (due < today) return 'overdue';
  if (due === today) return 'today';
  if (due <= addDays(today, 7)) return 'week';
  return 'later';
}

function typeFromAction(text) {
  const a = String(text || '');
  if (/טלפון|שיחה/.test(a)) return 'PHONE_CALL';
  if (/פגישה/.test(a)) return 'MEETING';
  if (/הצעה/.test(a)) return 'SEND_PROPOSAL';
  if (/להשיב|מייל|מעקב/.test(a)) return 'FOLLOWUP_EMAIL';
  return 'OTHER';
}

const run = (db, fn) => (db === prisma ? prisma.$transaction(fn) : fn(db));

function cleanInput(input, { partial = false } = {}) {
  const out = {};
  if (!partial || 'title' in input) {
    const title = String(input.title || '').trim();
    if (!title) throw bad('title_required');
    out.title = title.slice(0, 200);
  }
  if (!partial || 'taskType' in input) {
    const t = input.taskType || 'OTHER';
    if (!TYPES.includes(t)) throw bad('invalid_task_type');
    out.taskType = t;
  }
  if ('description' in input) out.description = String(input.description || '').trim().slice(0, 4000) || null;
  if (!partial || 'dueDate' in input) {
    const d = new Date(input.dueDate);
    if (!input.dueDate || Number.isNaN(d.getTime())) throw bad('invalid_date');
    out.dueDate = d;
  }
  if ('dueTime' in input) {
    const v = input.dueTime ? String(input.dueTime) : null;
    if (v && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw bad('invalid_time');
    out.dueTime = v;
  }
  if (!partial || 'priority' in input) {
    const p = input.priority || 'B';
    if (!PRIORITIES.includes(p)) throw bad('invalid_priority');
    out.priority = p;
  }
  if ('status' in input) {
    if (!STATUSES.includes(input.status)) throw bad('invalid_status');
    out.status = input.status;
  }
  return out;
}

// Timeline events. Task events never touch lastActivityAt, and each (lead, type, task, key) is written once.
async function logOnce(db, leadId, type, taskId, data = {}, key = '') {
  const dup = await db.activity.findFirst({ where: { leadId, type, AND: [{ data: { path: ['taskId'], equals: taskId } }, { data: { path: ['key'], equals: key } }] }, select: { id: true } });
  if (dup) return;
  await db.activity.create({ data: { leadId, type, data: { taskId, key, ...data } } });
}

async function mirrorToLead(db, task) {
  await db.lead.update({ where: { id: task.leadId }, data: { nextAction: task.title, nextFollowUpAt: task.dueDate } });
}
async function clearLeadMirror(db, leadId) {
  await db.lead.update({ where: { id: leadId }, data: { nextAction: null, nextFollowUpAt: null } });
}
const activeNext = (db, leadId) => db.task.findFirst({ where: { leadId, isNextAction: true, status: { in: ACTIVE } } });

async function createTask(leadId, input, { db = prisma } = {}) {
  const data = cleanInput(input);
  const key = input.dedupeKey ? String(input.dedupeKey).slice(0, 200) : null;
  try {
    return await run(db, async (tx) => {
      const lead = await tx.lead.findUnique({ where: { id: leadId }, select: { id: true } });
      if (!lead) throw bad('not_found', 404);
      if (key) {
        const dup = await tx.task.findUnique({ where: { dedupeKey: key } });
        if (dup) return { ...dup, duplicate: true };
      }
      const wantsNext = !!input.isNextAction;
      if (wantsNext) {
        const cur = await activeNext(tx, leadId);
        if (cur) {
          if (!input.replaceNext) throw bad('next_action_exists', 409);
          await tx.task.update({ where: { id: cur.id }, data: { isNextAction: false } });
        }
      }
      const task = await tx.task.create({ data: { ...data, status: data.status && ACTIVE.includes(data.status) ? data.status : 'OPEN', leadId, isNextAction: wantsNext, dedupeKey: key } });
      await logOnce(tx, leadId, 'TASK_CREATED', task.id, { title: task.title, taskType: task.taskType, dueDate: task.dueDate });
      if (wantsNext) await mirrorToLead(tx, task);
      return task;
    });
  } catch (e) {
    if (e.code === 'P2002') throw bad('next_action_exists', 409);
    throw e;
  }
}

async function completeTask(id, { next = null, db = prisma, now = new Date() } = {}) {
  try {
    return await run(db, async (tx) => {
      const t = await tx.task.findUnique({ where: { id } });
      if (!t) throw bad('not_found', 404);
      if (t.status === 'COMPLETED') return { task: t, next: null };
      const task = await tx.task.update({ where: { id }, data: { status: 'COMPLETED', completedAt: now } });
      await logOnce(tx, t.leadId, 'TASK_COMPLETED', id, { title: t.title });
      // Completing never closes the lead or changes its stage.
      if (t.isNextAction) await clearLeadMirror(tx, t.leadId);
      let created = null;
      if (next) {
        const data = cleanInput(next);
        created = await tx.task.create({ data: { ...data, status: 'OPEN', leadId: t.leadId, isNextAction: !!next.isNextAction || t.isNextAction } });
        await logOnce(tx, t.leadId, 'TASK_CREATED', created.id, { title: created.title, taskType: created.taskType, dueDate: created.dueDate });
        if (created.isNextAction) await mirrorToLead(tx, created);
      }
      return { task, next: created };
    });
  } catch (e) {
    if (e.code === 'P2002') throw bad('next_action_exists', 409);
    throw e;
  }
}

async function rescheduleTask(id, { dueDate, dueTime }, { db = prisma } = {}) {
  const d = new Date(dueDate);
  if (!dueDate || Number.isNaN(d.getTime())) throw bad('invalid_date');
  return run(db, async (tx) => {
    const t = await tx.task.findUnique({ where: { id } });
    if (!t) throw bad('not_found', 404);
    const patch = { dueDate: d };
    if (dueTime !== undefined) {
      if (dueTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(dueTime)) throw bad('invalid_time');
      patch.dueTime = dueTime || null;
    }
    const task = await tx.task.update({ where: { id }, data: patch });
    if (dayKey(t.dueDate) !== dayKey(d)) {
      await tx.activity.create({ data: { leadId: t.leadId, type: 'FOLLOWUP_DATE_CHANGED', data: { taskId: id, title: t.title, from: dayKey(t.dueDate), to: dayKey(d) } } });
    }
    if (t.isNextAction && isActive(t)) await mirrorToLead(tx, task);
    return task;
  });
}

async function updateTask(id, input, { db = prisma } = {}) {
  const data = cleanInput(input, { partial: true });
  if (data.status === 'COMPLETED') {
    const rest = { ...data }; delete rest.status;
    if (Object.keys(rest).length) await updateTask(id, rest, { db });
    return (await completeTask(id, { db })).task;
  }
  return run(db, async (tx) => {
    const t = await tx.task.findUnique({ where: { id } });
    if (!t) throw bad('not_found', 404);
    if (data.status && ACTIVE.includes(data.status) && !isActive(t)) {
      data.completedAt = null;
      if (t.isNextAction && (await activeNext(tx, t.leadId))) data.isNextAction = false;
    }
    if (data.status === 'CANCELLED') data.completedAt = null;
    const task = await tx.task.update({ where: { id }, data });
    if (data.dueDate && dayKey(t.dueDate) !== dayKey(data.dueDate)) {
      await tx.activity.create({ data: { leadId: t.leadId, type: 'FOLLOWUP_DATE_CHANGED', data: { taskId: id, title: t.title, from: dayKey(t.dueDate), to: dayKey(data.dueDate) } } });
    }
    if (task.isNextAction) {
      if (isActive(task)) await mirrorToLead(tx, task); else await clearLeadMirror(tx, t.leadId);
    }
    return task;
  });
}

async function setNextAction(id, { db = prisma } = {}) {
  try {
    return await run(db, async (tx) => {
      const t = await tx.task.findUnique({ where: { id } });
      if (!t) throw bad('not_found', 404);
      if (!isActive(t)) throw bad('task_not_active', 409);
      await tx.task.updateMany({ where: { leadId: t.leadId, isNextAction: true, status: { in: ACTIVE }, id: { not: id } }, data: { isNextAction: false } });
      const task = await tx.task.update({ where: { id }, data: { isNextAction: true } });
      await mirrorToLead(tx, task);
      return task;
    });
  } catch (e) {
    if (e.code === 'P2002') throw bad('next_action_exists', 409);
    throw e;
  }
}

async function deleteTask(id, { db = prisma } = {}) {
  return run(db, async (tx) => {
    const t = await tx.task.findUnique({ where: { id } });
    if (!t) throw bad('not_found', 404);
    if (t.status === 'COMPLETED') throw bad('completed_preserved', 409); // history is kept; cancel instead
    await tx.task.delete({ where: { id } });
    if (t.isNextAction && isActive(t)) await clearLeadMirror(tx, t.leadId);
  });
}

// Called after older code (interactions, manual mail, lead PATCH, close) changed lead.nextAction / nextFollowUpAt.
// Idempotent: makes the Next Action task match the lead fields, never creates a second one.
async function reconcileFromLead(leadId, db = prisma) {
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { id: true, nextAction: true, nextFollowUpAt: true } });
  if (!lead) return null;
  const cur = await activeNext(db, leadId);
  if (!lead.nextFollowUpAt) {
    if (!cur) return null;
    const task = await db.task.update({ where: { id: cur.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
    await logOnce(db, leadId, 'TASK_COMPLETED', cur.id, { title: cur.title });
    return task;
  }
  const title = lead.nextAction || 'מעקב';
  if (cur) {
    if (cur.title === title && dayKey(cur.dueDate) === dayKey(lead.nextFollowUpAt)) return cur;
    const task = await db.task.update({ where: { id: cur.id }, data: { title, taskType: typeFromAction(title), dueDate: lead.nextFollowUpAt } });
    if (dayKey(cur.dueDate) !== dayKey(lead.nextFollowUpAt)) {
      await db.activity.create({ data: { leadId, type: 'FOLLOWUP_DATE_CHANGED', data: { taskId: cur.id, title, from: dayKey(cur.dueDate), to: dayKey(lead.nextFollowUpAt) } } });
    }
    return task;
  }
  try {
    const task = await db.task.create({ data: { leadId, title, taskType: typeFromAction(title), dueDate: lead.nextFollowUpAt, priority: 'B', status: 'OPEN', isNextAction: true } });
    await logOnce(db, leadId, 'TASK_CREATED', task.id, { title, taskType: task.taskType, dueDate: task.dueDate, auto: true });
    return task;
  } catch (e) {
    if (e.code === 'P2002') return activeNext(db, leadId); // lost a race: the other writer made it
    throw e;
  }
}

const VIEWS = ['all', 'overdue', 'today', 'week', 'waiting', 'completed'];
const SORTS = { due: 'dueDate', org: 'org', title: 'title', type: 'taskType', priority: 'priority', status: 'status' };

async function listTasks(q = {}, now = new Date()) {
  const view = VIEWS.includes(q.view) ? q.view : 'all';
  const where = { lead: { stage: { not: 'LOST' } } };
  const list = (v) => String(v).split(',').map((x) => x.trim()).filter(Boolean);
  if (q.priority) where.priority = { in: list(q.priority) };
  if (q.taskType) where.taskType = { in: list(q.taskType) };
  if (q.status) where.status = { in: list(q.status) };
  if (q.leadId) where.leadId = Number(q.leadId);
  if (q.country) where.lead.country = { in: list(q.country) };
  if (q.leadType) where.lead.segment = { in: list(q.leadType) };
  if (q.org) where.lead.OR = [{ company: { contains: q.org, mode: 'insensitive' } }, { name: { contains: q.org, mode: 'insensitive' } }];
  if (q.q) where.OR = [{ title: { contains: q.q, mode: 'insensitive' } }, { description: { contains: q.q, mode: 'insensitive' } }, { lead: { company: { contains: q.q, mode: 'insensitive' } } }, { lead: { name: { contains: q.q, mode: 'insensitive' } } }];
  if (view === 'waiting') where.status = 'WAITING';
  if (view === 'completed') where.status = 'COMPLETED';
  const rows = await prisma.task.findMany({ where, include: { lead: { select: { id: true, name: true, company: true, country: true, segment: true, stage: true, email: true } } }, take: 3000 });
  let out = rows.map((t) => ({ ...t, bucket: bucket(t, now) }));
  if (['overdue', 'today', 'week'].includes(view)) {
    out = out.filter((t) => (view === 'week' ? t.bucket === 'today' || t.bucket === 'week' : t.bucket === view));
  }
  const key = SORTS[q.sort] || 'dueDate';
  const dir = q.dir === 'desc' ? -1 : 1;
  const val = (t) => (key === 'org' ? String(t.lead.company || t.lead.name).toLowerCase() : key === 'dueDate' ? `${dayKey(t.dueDate)} ${t.dueTime || '99:99'}` : String(t[key]).toLowerCase());
  out.sort((a, b) => {
    if (view === 'all' && isActive(a) !== isActive(b)) return isActive(a) ? -1 : 1; // active first
    const x = val(a); const y = val(b);
    return (x < y ? -1 : x > y ? 1 : a.id - b.id) * dir;
  });
  return out;
}

async function summary(now = new Date()) {
  const rows = await prisma.task.findMany({ where: { status: { in: ACTIVE }, lead: { stage: { not: 'LOST' } } }, select: { id: true, dueDate: true, status: true, leadId: true } });
  const c = { overdue: 0, today: 0, week: 0, waiting: 0, extraDue: 0 };
  const nextIds = new Set((await prisma.task.findMany({ where: { isNextAction: true, status: { in: ACTIVE } }, select: { id: true } })).map((t) => t.id));
  for (const t of rows) {
    const b = bucket(t, now);
    if ((b === 'overdue' || b === 'today') && !nextIds.has(t.id)) c.extraDue += 1; // not already shown in the lead-based list
    if (b === 'overdue') c.overdue += 1;
    if (b === 'today') c.today += 1;
    if (b === 'week' || b === 'today') c.week += 1; // "this week" = next 7 days, today included
    if (t.status === 'WAITING') c.waiting += 1;
  }
  const noNext = await prisma.lead.count({
    where: { stage: { notIn: ['WON', 'LOST'] }, unsubscribed: false, bounced: false, nextFollowUpAt: null, tasks: { none: { isNextAction: true, status: { in: ACTIVE } } } },
  });
  const review = await prisma.lead.count({ where: { replied: true, nextAction: 'להשיב', stage: { notIn: ['WON', 'LOST'] }, unsubscribed: false } });
  return { overdue: c.overdue, today: c.today, week: c.week, waiting: c.waiting, extraDue: c.extraDue, noNextAction: noNext, needsReview: review };
}

async function leadsWithoutNext() {
  return prisma.lead.findMany({
    where: { stage: { notIn: ['WON', 'LOST'] }, unsubscribed: false, bounced: false, nextFollowUpAt: null, tasks: { none: { isNextAction: true, status: { in: ACTIVE } } } },
    select: { id: true, name: true, company: true, country: true, segment: true, stage: true, priority: true },
    orderBy: { lastActivityAt: 'desc' }, take: 300,
  });
}

module.exports = {
  TYPES, STATUSES, ACTIVE, PRIORITIES, dayKey, bucket, typeFromAction,
  createTask, completeTask, rescheduleTask, updateTask, setNextAction, deleteTask, reconcileFromLead, listTasks, summary, leadsWithoutNext,
};
