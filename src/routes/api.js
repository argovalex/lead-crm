const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const prisma = require('../db');
const leads = require('../services/leads');
const email = require('../services/email');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const id = (v) => {
  const n = parseInt(v, 10);
  if (!Number.isInteger(n) || n <= 0) throw Object.assign(new Error('invalid_id'), { status: 400 });
  return n;
};
const EDITABLE = ['name', 'phone', 'company', 'source', 'notes', 'owner'];

// ---------- Leads ----------
router.get('/leads', wrap(async (req, res) => {
  const { stage, tag, source, q, inactiveDays, stale } = req.query;
  const where = {};
  if (stage) where.stage = stage;
  if (tag) where.tags = { has: tag };
  if (source) where.source = source;
  if (stale === 'true') where.stale = true;
  if (inactiveDays) where.lastActivityAt = { lt: new Date(Date.now() - Number(inactiveDays) * email.DAY) };
  if (q) where.OR = ['name', 'email', 'company', 'phone'].map((f) => ({ [f]: { contains: q, mode: 'insensitive' } }));
  const rows = await prisma.lead.findMany({ where, orderBy: { lastActivityAt: 'desc' }, take: 1000 });
  res.json(rows);
}));

router.get('/leads/meta', wrap(async (_req, res) => {
  const [sources, tags] = await Promise.all([
    prisma.lead.findMany({ where: { source: { not: null } }, distinct: ['source'], select: { source: true } }),
    prisma.$queryRaw`SELECT DISTINCT unnest(tags) AS tag FROM "Lead" ORDER BY 1`,
  ]);
  res.json({ stages: leads.STAGES, sources: sources.map((s) => s.source), tags: tags.map((t) => t.tag) });
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
