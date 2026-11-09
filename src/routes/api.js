const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const prisma = require('../db');
const leads = require('../services/leads');
const email = require('../services/email');
const settings = require('../services/settings');
const config = require('../config');
const { getProvider } = require('../services/provider');
const mailimport = require('../services/mailimport');
const segments = require('../services/segments');
const { suggestReply } = require('../services/suggest');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const id = (v) => {
  const n = parseInt(v, 10);
  if (!Number.isInteger(n) || n <= 0) throw Object.assign(new Error('invalid_id'), { status: 400 });
  return n;
};
const EDITABLE = ['name', 'phone', 'company', 'source', 'notes', 'owner', 'country', 'segment', 'priority', 'website', 'nextAction'];

// ---------- Leads ----------
// Search leads by the kind of activity on their timeline.
const ACTIVITY_FILTERS = {
  mail_any: ['EMAIL_SENT', 'MANUAL_EMAIL_OUT'],
  email_sent: ['EMAIL_SENT'],
  manual_email: ['MANUAL_EMAIL_OUT'],
  reply: ['REPLY_IN', 'EMAIL_REPLIED'],
  call: ['CALL'],
  meeting: ['MEETING'],
  sms: ['SMS_OUT', 'SMS_IN'],
  note: ['NOTE'],
  enrolled: ['SEQUENCE_ENROLLED'],
  failed: ['EMAIL_FAILED'],
};
router.get('/leads', wrap(async (req, res) => {
  const { stage, tag, source, q, inactiveDays, stale, priority, country, activity, segment } = req.query;
  const where = {};
  if (activity) {
    const types = ACTIVITY_FILTERS[activity === 'none_mail' ? 'mail_any' : activity];
    if (!types) return res.status(400).json({ error: 'invalid_activity' });
    where.activities = activity === 'none_mail' ? { none: { type: { in: types } } } : { some: { type: { in: types } } };
  }
  const list = (v) => String(v).split(',').map((x) => x.trim()).filter(Boolean);
  if (priority) where.priority = priority;
  if (country) where.country = { in: list(country) };
  if (segment) where.segment = { in: list(segment) };
  if (stage) where.stage = stage;
  if (tag) where.tags = { hasSome: list(tag) };
  if (source) where.source = source;
  if (stale === 'true') where.stale = true;
  if (inactiveDays) where.lastActivityAt = { lt: new Date(Date.now() - Number(inactiveDays) * email.DAY) };
  if (q) where.OR = ['name', 'email', 'company', 'phone', 'segment'].map((f) => ({ [f]: { contains: q, mode: 'insensitive' } }));
  const rows = await prisma.lead.findMany({ where, orderBy: { lastActivityAt: 'desc' }, take: 1000 });
  res.json(rows);
}));

router.get('/leads/meta', wrap(async (_req, res) => {
  const [sources, tags, countries, segments] = await Promise.all([
    prisma.lead.findMany({ where: { source: { not: null } }, distinct: ['source'], select: { source: true } }),
    prisma.$queryRaw`SELECT DISTINCT unnest(tags) AS tag FROM "Lead" ORDER BY 1`,
    prisma.lead.findMany({ where: { country: { not: null } }, distinct: ['country'], select: { country: true }, orderBy: { country: 'asc' } }),
    prisma.lead.findMany({ where: { segment: { not: null } }, distinct: ['segment'], select: { segment: true }, orderBy: { segment: 'asc' } }),
  ]);
  res.json({ stages: leads.STAGES, sources: sources.map((s) => s.source), tags: tags.map((t) => t.tag), countries: countries.map((c) => c.country), segments: segments.map((s) => s.segment).filter(Boolean) });
}));

router.post('/leads', wrap(async (req, res) => {
  try {
    res.status(201).json(await leads.createLead(req.body));
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'duplicate_email' });
    throw e;
  }
}));

router.get('/leads/:id', wrap(async (req, res) => {
  const lead = await prisma.lead.findUnique({
    where: { id: id(req.params.id) },
    include: {
      activities: { orderBy: { createdAt: 'desc' }, take: 300 },
      enrollments: { include: { sequence: { select: { name: true } } } },
    },
  });
  if (!lead) return res.status(404).json({ error: 'not_found' });
  res.json(lead);
}));

router.patch('/leads/:id', wrap(async (req, res) => {
  const leadId = id(req.params.id);
  const data = {};
  for (const k of EDITABLE) if (k in req.body) data[k] = req.body[k] || null;
  if ('name' in data && !data.name) return res.status(400).json({ error: 'name_required' });
  if ('nextFollowUpAt' in req.body) {
    const d = req.body.nextFollowUpAt ? new Date(req.body.nextFollowUpAt) : null;
    if (d && Number.isNaN(d.getTime())) return res.status(400).json({ error: 'invalid_date' });
    data.nextFollowUpAt = d;
  }
  if ('tags' in req.body) data.tags = leads.normTags(req.body.tags);
  const lead = await prisma.lead.update({ where: { id: leadId }, data });
  if (req.body.stage) await leads.changeStage(leadId, req.body.stage);
  res.json(await prisma.lead.findUnique({ where: { id: lead.id } }));
}));

router.delete('/leads/:id', wrap(async (req, res) => {
  await prisma.lead.delete({ where: { id: id(req.params.id) } });
  res.status(204).end();
}));

router.post('/leads/:id/stage', wrap(async (req, res) => {
  res.json(await leads.changeStage(id(req.params.id), req.body.stage));
}));

router.post('/leads/:id/notes', wrap(async (req, res) => {
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text_required' });
  await leads.logActivity(id(req.params.id), 'NOTE', { text });
  res.status(201).json({ ok: true });
}));

// Log an interaction that happened outside the system (kind: EMAIL_OUT|EMAIL_IN|SMS_OUT|SMS_IN|CALL|MEETING).
router.post('/leads/:id/log', wrap(async (req, res) => {
  res.status(201).json(await leads.logInteraction(id(req.params.id), req.body));
}));

// Same by email address; creates the lead if unknown. Used for pasting a received reply.
router.post('/interactions', wrap(async (req, res) => {
  res.status(201).json(await leads.logInteractionByEmail(req.body));
}));

// Leads that need action: follow-up due or overdue, plus replies awaiting an answer.
router.get('/followups', wrap(async (_req, res) => {
  const rows = await prisma.lead.findMany({
    where: { nextFollowUpAt: { not: null }, stage: { notIn: ['WON', 'LOST'] }, unsubscribed: false },
    orderBy: { nextFollowUpAt: 'asc' }, take: 500,
    include: { activities: { where: { type: { in: ['REPLY_IN', 'SMS_IN', 'MANUAL_EMAIL_OUT', 'SMS_OUT', 'CALL', 'MEETING', 'NOTE'] } }, orderBy: { createdAt: 'desc' }, take: 1 } },
  });
  res.json(rows);
}));

// Write a new email to any address: finds or creates the lead, then queues the message.
router.post('/compose', wrap(async (req, res) => {
  const { email: to, name, company, subject, body } = req.body || {};
  const addr = leads.normEmail(to);
  if (!leads.isEmail(addr)) return res.status(400).json({ error: 'invalid_email' });
  if (!subject || !body) return res.status(400).json({ error: 'subject_and_body_required' });
  let lead = await prisma.lead.findUnique({ where: { email: addr } });
  let created = false;
  if (!lead) {
    lead = await leads.createLead({ name: name || company || addr.split('@')[0], email: addr, company, source: 'manual outreach' });
    created = true;
  }
  const msg = await email.queueSingle(lead.id, subject, body);
  await leads.logActivity(lead.id, 'EMAIL_QUEUED', { messageId: msg.id, subject: msg.subject });
  res.status(202).json({ queued: msg.id, leadId: lead.id, created });
}));

router.post('/leads/:id/replied', wrap(async (req, res) => {
  await leads.markReplied(id(req.params.id), { source: 'manual' });
  res.json({ ok: true });
}));

router.post('/leads/:id/email', wrap(async (req, res) => {
  const msg = await email.queueSingle(id(req.params.id), req.body.subject, req.body.body);
  await leads.logActivity(msg.leadId, 'EMAIL_QUEUED', { messageId: msg.id, subject: msg.subject });
  res.status(202).json({ queued: msg.id });
}));

router.post('/leads/:id/enroll', wrap(async (req, res) => {
  res.status(201).json(await email.enroll(id(req.params.id), id(req.body.sequenceId)));
}));

router.post('/leads/:id/unenroll', wrap(async (req, res) => {
  const n = await leads.stopEnrollments(id(req.params.id), 'manual');
  res.json({ stopped: n });
}));

// Bulk enroll
router.post('/sequences/:id/enroll', wrap(async (req, res) => {
  const seqId = id(req.params.id);
  const ids = (req.body.leadIds || []).map(id);
  const result = { enrolled: 0, skipped: 0 };
  for (const leadId of ids) {
    try { await email.enroll(leadId, seqId); result.enrolled += 1; } catch { result.skipped += 1; }
  }
  res.json(result);
}));

// ---------- CSV import ----------
const HEADER_MAP = {
  name: 'name', 'full name': 'name', 'שם': 'name', 'שם מלא': 'name',
  email: 'email', 'e-mail': 'email', 'אימייל': 'email', 'מייל': 'email', 'דוא"ל': 'email',
  phone: 'phone', 'טלפון': 'phone', 'נייד': 'phone',
  company: 'company', 'חברה': 'company',
  source: 'source', 'מקור': 'source',
  tags: 'tags', 'תגיות': 'tags',
  notes: 'notes', 'הערות': 'notes',
  owner: 'owner', 'אחראי': 'owner',
  country: 'country', 'מדינה': 'country', segment: 'segment', 'סגמנט': 'segment',
  priority: 'priority', 'עדיפות': 'priority', website: 'website', 'אתר': 'website',
  sent_at: 'sent_at', 'sent at': 'sent_at', date: 'sent_at', 'תאריך': 'sent_at', 'תאריך שליחה': 'sent_at',
  subject: 'subject', 'נושא': 'subject',
};

router.post('/import', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file_required' });
  let records;
  try {
    records = parse(req.file.buffer.toString('utf8').replace(/^﻿/, ''), {
      columns: (h) => h.map((c) => HEADER_MAP[String(c).trim().toLowerCase()] || null),
      skip_empty_lines: true, trim: true, relax_column_count: true,
    });
  } catch (e) {
    return res.status(400).json({ error: 'invalid_csv', detail: e.message });
  }
  const result = { created: 0, duplicates: [], invalid: [] };
  const seen = new Set();
  const existing = new Set((await prisma.lead.findMany({ select: { email: true } })).map((l) => l.email));
  for (const [i, r] of records.entries()) {
    const em = leads.normEmail(r.email);
    const row = i + 2;
    if (!leads.isEmail(em)) { result.invalid.push({ row, reason: 'invalid_email' }); continue; }
    if (seen.has(em) || existing.has(em)) { result.duplicates.push({ row, email: em }); continue; }
    seen.add(em);
    try {
      await leads.createLead({ ...r, name: r.name || em.split('@')[0], email: em, source: r.source || req.body.source || 'csv' });
      result.created += 1;
    } catch (e) {
      if (e.code === 'P2002') result.duplicates.push({ row, email: em });
      else result.invalid.push({ row, reason: e.message });
    }
  }
  res.json(result);
}));

// ---------- Import emails already sent by hand ----------
// CSV: email (required), sent_at (date), subject, name, company, country, segment, priority, notes.
// Creates the lead when missing, logs a manual outbound email with the real date, stage -> CONTACTED.
router.post('/import-sent', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file_required' });
  let records;
  try {
    records = parse(req.file.buffer.toString('utf8').replace(/^﻿/, ''), {
      columns: (h) => h.map((c) => HEADER_MAP[String(c).trim().toLowerCase()] || null),
      skip_empty_lines: true, trim: true, relax_column_count: true,
    });
  } catch (e) {
    return res.status(400).json({ error: 'invalid_csv', detail: e.message });
  }
  const result = { logged: 0, created: 0, skipped: [], invalid: [] };
  for (const [i, r] of records.entries()) {
    const row = i + 2;
    const em = leads.normEmail(r.email);
    if (!leads.isEmail(em)) { result.invalid.push({ row, reason: 'invalid_email' }); continue; }
    try {
      const existing = await prisma.lead.findUnique({ where: { email: em } });
      if (existing && !req.body.allowRepeat) {
        const dup = await prisma.activity.findFirst({ where: { leadId: existing.id, type: 'MANUAL_EMAIL_OUT' } });
        if (dup) { result.skipped.push({ row, email: em, reason: 'already_logged' }); continue; }
      }
      const out = await leads.logInteractionByEmail({
        ...r, email: em, kind: 'EMAIL_OUT', at: r.sent_at || req.body.sentAt || undefined,
        subject: r.subject || req.body.subject, source: r.source || req.body.source || 'manual outreach',
      });
      result.logged += 1;
      if (out.created) result.created += 1;
    } catch (e) {
      result.invalid.push({ row, reason: e.message });
    }
  }
  res.json(result);
}));

// ---------- Settings (signature, approval mode) ----------
router.get('/settings', wrap(async (_req, res) => { res.json(await settings.getAll()); }));

router.put('/settings', wrap(async (req, res) => {
  if ('signatureHtml' in req.body) await settings.set('signatureHtml', req.body.signatureHtml || '');
  if ('requireApproval' in req.body) await settings.set('requireApproval', req.body.requireApproval ? 'true' : 'false');
  res.json(await settings.getAll());
}));

// ---------- Preview / test send ----------
const SAMPLE_LEAD = { name: 'Fotini Kanat', email: 'sample@example.com', company: 'MG Yachts', unsubToken: 'preview' };

router.post('/preview', wrap(async (req, res) => {
  const { subject, body, leadId } = req.body || {};
  const lead = leadId ? await prisma.lead.findUnique({ where: { id: id(leadId) } }) : null;
  const built = email.buildEmail(lead || SAMPLE_LEAD, subject || '', body || '', await settings.getAll());
  res.json({ subject: built.subject, html: built.html, text: built.text, sampleLead: !lead });
}));

// Sends the rendered email to the admin's own address so it can be checked in a real inbox.
router.post('/test-email', wrap(async (req, res) => {
  const { subject, body, leadId } = req.body || {};
  if (!subject || !body) return res.status(400).json({ error: 'subject_and_body_required' });
  const lead = leadId ? await prisma.lead.findUnique({ where: { id: id(leadId) } }) : null;
  const built = email.buildEmail(lead || SAMPLE_LEAD, subject, body, await settings.getAll());
  const to = config.adminEmail;
  const { providerId } = await getProvider().send({ to, ...built, subject: `[בדיקה] ${built.subject}`, idempotencyKey: `test:${Date.now()}:${Math.random().toString(36).slice(2, 8)}` });
  res.json({ sentTo: to, providerId });
}));

// ---------- Outbox: review, edit, approve or cancel messages before they go out ----------
router.get('/outbox', wrap(async (_req, res) => {
  const rows = await prisma.emailMessage.findMany({
    where: { status: { in: ['DRAFT', 'QUEUED'] } },
    orderBy: { createdAt: 'asc' }, take: 300,
    select: { id: true, subject: true, body: true, status: true, createdAt: true, stepIndex: true, enrollmentId: true, lead: { select: { id: true, name: true, email: true, company: true } } },
  });
  res.json(rows);
}));

router.patch('/messages/:id', wrap(async (req, res) => {
  const data = {};
  if (typeof req.body.subject === 'string' && req.body.subject.trim()) data.subject = req.body.subject;
  if (typeof req.body.body === 'string' && req.body.body.trim()) data.body = req.body.body;
  if (!Object.keys(data).length) return res.status(400).json({ error: 'subject_and_body_required' });
  const r = await prisma.emailMessage.updateMany({ where: { id: id(req.params.id), status: { in: ['DRAFT', 'QUEUED'] } }, data });
  if (!r.count) return res.status(409).json({ error: 'message_not_editable' });
  res.json({ ok: true });
}));

router.post('/messages/:id/approve', wrap(async (req, res) => {
  const r = await prisma.emailMessage.updateMany({ where: { id: id(req.params.id), status: 'DRAFT' }, data: { status: 'QUEUED' } });
  if (!r.count) return res.status(409).json({ error: 'message_not_editable' });
  res.json({ ok: true });
}));

router.post('/messages/:id/cancel', wrap(async (req, res) => {
  const r = await prisma.emailMessage.updateMany({ where: { id: id(req.params.id), status: { in: ['DRAFT', 'QUEUED'] } }, data: { status: 'CANCELLED', lastError: 'cancelled_by_admin' } });
  if (!r.count) return res.status(409).json({ error: 'message_not_editable' });
  res.json({ ok: true });
}));

router.post('/outbox/approve-all', wrap(async (_req, res) => {
  const r = await prisma.emailMessage.updateMany({ where: { status: 'DRAFT' }, data: { status: 'QUEUED' } });
  res.json({ approved: r.count });
}));

// ---------- Sequences ----------
router.get('/sequences', wrap(async (_req, res) => {
  const seqs = await prisma.sequence.findMany({
    include: { steps: { orderBy: { index: 'asc' } }, _count: { select: { enrollments: true } } },
    orderBy: { createdAt: 'desc' },
  });
  const active = await prisma.enrollment.groupBy({ by: ['sequenceId'], where: { status: 'ACTIVE' }, _count: true });
  const activeMap = Object.fromEntries(active.map((a) => [a.sequenceId, a._count]));
  res.json(seqs.map((s) => ({ ...s, activeCount: activeMap[s.id] || 0 })));
}));

function validateSteps(steps) {
  if (!Array.isArray(steps) || !steps.length) throw Object.assign(new Error('steps_required'), { status: 400 });
  let prev = -1;
  return steps.map((s, i) => {
    const delayDays = parseInt(s.delayDays, 10);
    if (!Number.isInteger(delayDays) || delayDays < 0 || delayDays < prev) throw Object.assign(new Error('delays_must_be_ascending'), { status: 400 });
    if (!s.subject || !s.body) throw Object.assign(new Error('subject_and_body_required'), { status: 400 });
    prev = delayDays;
    return { index: i, delayDays, subject: s.subject, body: s.body };
  });
}

router.post('/sequences', wrap(async (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: 'name_required' });
  const steps = validateSteps(req.body.steps);
  const seq = await prisma.sequence.create({ data: { name: req.body.name, steps: { create: steps } }, include: { steps: true } });
  res.status(201).json(seq);
}));

router.put('/sequences/:id', wrap(async (req, res) => {
  const seqId = id(req.params.id);
  const active = await prisma.enrollment.count({ where: { sequenceId: seqId, status: 'ACTIVE' } });
  if (active && req.body.steps) return res.status(409).json({ error: 'sequence_has_active_enrollments' });
  const data = {};
  if (req.body.name) data.name = req.body.name;
  await prisma.$transaction(async (tx) => {
    if (req.body.steps) {
      const steps = validateSteps(req.body.steps);
      await tx.sequenceStep.deleteMany({ where: { sequenceId: seqId } });
      await tx.sequenceStep.createMany({ data: steps.map((s) => ({ ...s, sequenceId: seqId })) });
    }
    await tx.sequence.update({ where: { id: seqId }, data });
  });
  res.json(await prisma.sequence.findUnique({ where: { id: seqId }, include: { steps: { orderBy: { index: 'asc' } } } }));
}));

router.delete('/sequences/:id', wrap(async (req, res) => {
  const seqId = id(req.params.id);
  const active = await prisma.enrollment.count({ where: { sequenceId: seqId, status: 'ACTIVE' } });
  if (active) return res.status(409).json({ error: 'sequence_has_active_enrollments' });
  await prisma.sequence.delete({ where: { id: seqId } });
  res.status(204).end();
}));

// Fills an empty "segment" from the company name. Never overwrites a value you set. ?dry=1 only counts.
router.post('/leads/auto-segment', wrap(async (req, res) => {
  const rows = await prisma.lead.findMany({ where: { OR: [{ segment: null }, { segment: '' }] }, select: { id: true, company: true } });
  const by = {};
  let none = 0;
  for (const r of rows) {
    const seg = segments.classify(r.company);
    if (!seg) { none += 1; continue; }
    (by[seg] = by[seg] || []).push(r.id);
  }
  const counts = Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.length]));
  if (!req.query.dry) {
    for (const [seg, ids] of Object.entries(by)) await prisma.lead.updateMany({ where: { id: { in: ids }, OR: [{ segment: null }, { segment: '' }] }, data: { segment: seg } });
  }
  res.json({ checked: rows.length, counts, unclassified: none, applied: !req.query.dry });
}));

// ---------- Mailbox: one conversation per lead (campaign, personal and received mail) ----------
const MAIL_ACTS = ['REPLY_IN', 'MANUAL_EMAIL_OUT'];
const snip = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 140);
const mailItems = (msgs, acts) => [
  ...msgs.map((m) => ({ dir: 'out', kind: m.enrollmentId ? 'campaign' : 'manual', subject: m.subject, body: m.body, at: m.sentAt || m.createdAt, status: m.status, opened: !!m.openedAt, clicked: !!m.clickedAt, leadId: m.leadId })),
  ...acts.map((a) => ({ dir: a.type === 'REPLY_IN' ? 'in' : 'out', kind: a.type === 'REPLY_IN' ? 'reply' : 'logged', subject: (a.data || {}).subject || '', body: (a.data || {}).body || '', at: a.createdAt, status: 'SENT', leadId: a.leadId })),
].sort((a, b) => new Date(a.at) - new Date(b.at));
const MSG_SEL = { leadId: true, subject: true, body: true, enrollmentId: true, status: true, createdAt: true, sentAt: true, openedAt: true, clickedAt: true };
const MSG_OK = { in: ['SENT', 'QUEUED', 'SENDING', 'DRAFT'] };

router.get('/mailbox', wrap(async (_req, res) => {
  const [msgs, acts] = await Promise.all([
    prisma.emailMessage.findMany({ where: { status: { in: MSG_OK.in } }, orderBy: { createdAt: 'desc' }, take: 800, select: MSG_SEL }),
    prisma.activity.findMany({ where: { type: { in: MAIL_ACTS } }, orderBy: { createdAt: 'desc' }, take: 800, select: { leadId: true, type: true, data: true, createdAt: true } }),
  ]);
  const byLead = new Map();
  mailItems(msgs, acts).forEach((it) => {
    const c = byLead.get(it.leadId) || { leadId: it.leadId, replies: 0, sent: 0, campaign: 0, pending: 0, last: null };
    if (it.dir === 'in') c.replies += 1; else c.sent += 1;
    if (it.kind === 'campaign') c.campaign += 1;
    if (it.status !== 'SENT') c.pending += 1;
    c.last = it; // ascending order, so the last assignment is the newest
    byLead.set(it.leadId, c);
  });
  const rows = await prisma.lead.findMany({ where: { id: { in: [...byLead.keys()] } }, select: { id: true, name: true, email: true, company: true, stage: true, replied: true, nextAction: true, unsubscribed: true, bounced: true } });
  const out = rows.map((l) => {
    const c = byLead.get(l.id);
    return { lead: l, replies: c.replies, sent: c.sent, campaign: c.campaign, pending: c.pending, awaiting: l.replied && l.nextAction === 'להשיב', last: { dir: c.last.dir, kind: c.last.kind, subject: c.last.subject, snippet: snip(c.last.body), at: c.last.at } };
  }).sort((a, b) => new Date(b.last.at) - new Date(a.last.at));
  res.json(out);
}));

router.get('/leads/:id/thread', wrap(async (req, res) => {
  const leadId = id(req.params.id);
  const [lead, msgs, acts] = await Promise.all([
    prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, name: true, email: true, company: true, stage: true, replied: true, unsubscribed: true, bounced: true } }),
    prisma.emailMessage.findMany({ where: { leadId, status: { in: MSG_OK.in } }, orderBy: { createdAt: 'asc' }, select: MSG_SEL }),
    prisma.activity.findMany({ where: { leadId, type: { in: MAIL_ACTS } }, orderBy: { createdAt: 'asc' }, select: { leadId: true, type: true, data: true, createdAt: true } }),
  ]);
  if (!lead) return res.status(404).json({ error: 'not_found' });
  res.json({ lead, items: mailItems(msgs, acts) });
}));

router.post('/leads/:id/suggest-reply', wrap(async (req, res) => {
  const leadId = id(req.params.id);
  const [lead, msgs, acts] = await Promise.all([
    prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, name: true, company: true } }),
    prisma.emailMessage.findMany({ where: { leadId, status: { in: MSG_OK.in } }, orderBy: { createdAt: 'asc' }, select: MSG_SEL }),
    prisma.activity.findMany({ where: { leadId, type: { in: MAIL_ACTS } }, orderBy: { createdAt: 'asc' }, select: { leadId: true, type: true, data: true, createdAt: true } }),
  ]);
  if (!lead) return res.status(404).json({ error: 'not_found' });
  res.json(await suggestReply(lead, mailItems(msgs, acts)));
}));

// Import mail sent by hand from alex@alargov.com: .eml files or an .mbox export (Gmail / Google Takeout).
router.post('/import-eml', upload.array('files', 200), wrap(async (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'file_required' });
  res.json(await mailimport.importSent(req.files, { source: req.body.source || undefined }));
}));

// One-off email to several selected leads (not a campaign): each gets its own queued message,
// a timeline entry, and the usual follow-up reminder after it is sent.
router.post('/leads/bulk-email', wrap(async (req, res) => {
  const ids = (Array.isArray(req.body && req.body.ids) ? req.body.ids : []).map((v) => id(v));
  const { subject, body } = req.body || {};
  if (!ids.length) return res.status(400).json({ error: 'no_ids' });
  if (!subject || !body) return res.status(400).json({ error: 'subject_and_body_required' });
  if (ids.length > 200) return res.status(400).json({ error: 'too_many_recipients' });
  let queued = 0;
  const skipped = [];
  for (const leadId of ids) {
    try {
      const msg = await email.queueSingle(leadId, subject, body);
      await leads.logActivity(leadId, 'EMAIL_QUEUED', { messageId: msg.id, subject: msg.subject });
      queued += 1;
    } catch (e) { skipped.push({ id: leadId, reason: e.message }); }
  }
  res.status(202).json({ queued, skipped });
}));

router.post('/leads/bulk-delete', wrap(async (req, res) => {
  const ids = (Array.isArray(req.body && req.body.ids) ? req.body.ids : []).map((v) => id(v));
  if (!ids.length) return res.status(400).json({ error: 'no_ids' });
  const r = await prisma.lead.deleteMany({ where: { id: { in: ids } } });
  res.json({ deleted: r.count });
}));

// ---------- Stats ----------
router.get('/stats', wrap(async (req, res) => {
  const days = Math.min(parseInt(req.query.days, 10) || 30, 365);
  const since = new Date(Date.now() - days * email.DAY);
  const sentWhere = { status: 'SENT', sentAt: { gte: since } };
  const [sent, opened, clicked, bounced, emailedLeads, repliedLeads, byStage, total, queued, sentToday] = await Promise.all([
    prisma.emailMessage.count({ where: sentWhere }),
    prisma.emailMessage.count({ where: { ...sentWhere, openedAt: { not: null } } }),
    prisma.emailMessage.count({ where: { ...sentWhere, clickedAt: { not: null } } }),
    prisma.emailMessage.count({ where: { ...sentWhere, bouncedAt: { not: null } } }),
    prisma.emailMessage.findMany({ where: sentWhere, distinct: ['leadId'], select: { leadId: true } }),
    prisma.activity.findMany({ where: { type: 'EMAIL_REPLIED', createdAt: { gte: since } }, distinct: ['leadId'], select: { leadId: true } }),
    prisma.lead.groupBy({ by: ['stage'], _count: true }),
    prisma.lead.count(),
    prisma.emailMessage.count({ where: { status: { in: ['QUEUED', 'SENDING'] } } }),
    prisma.emailMessage.count({ where: { sentAt: { gte: new Date(new Date().setUTCHours(0, 0, 0, 0)) } } }),
  ]);
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  const counts = Object.fromEntries(leads.STAGES.map((s) => [s, 0]));
  byStage.forEach((r) => { counts[r.stage] = r._count; });
  // Funnel: share of non-lost leads that reached at least each stage (current stage as proxy).
  const open = leads.STAGES.slice(0, 6);
  const funnel = open.map((s, i) => {
    const reached = open.slice(i).reduce((acc, st) => acc + counts[st], 0);
    return { stage: s, count: counts[s], reached, conversion: pct(reached, total - counts.LOST) };
  });
  res.json({
    days, sent, opened, clicked, bounced, queued, sentToday,
    openRate: pct(opened, sent), clickRate: pct(clicked, sent), bounceRate: pct(bounced, sent),
    replyRate: pct(repliedLeads.length, emailedLeads.length),
    totalLeads: total, stages: counts, funnel,
    winRate: pct(counts.WON, counts.WON + counts.LOST),
  });
}));

router.get('/messages', wrap(async (req, res) => {
  const where = req.query.status ? { status: req.query.status } : {};
  res.json(await prisma.emailMessage.findMany({
    where, orderBy: { createdAt: 'desc' }, take: 200,
    select: { id: true, subject: true, status: true, createdAt: true, sentAt: true, openedAt: true, clickedAt: true, lastError: true, lead: { select: { id: true, name: true, email: true } } },
  }));
}));

module.exports = router;
