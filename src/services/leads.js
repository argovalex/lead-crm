const crypto = require('crypto');
const prisma = require('../db');

const STAGES = ['NEW', 'CONTACTED', 'ENGAGED', 'QUALIFIED', 'PROPOSAL', 'WON', 'LOST'];
const stageRank = (s) => STAGES.indexOf(s);

const newToken = () => crypto.randomBytes(24).toString('base64url');
const normEmail = (e) => String(e || '').trim().toLowerCase();
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

async function logActivity(leadId, type, data = null, db = prisma, now = new Date()) {
  await db.activity.create({ data: { leadId, type, data, createdAt: now } });
  await db.lead.update({ where: { id: leadId }, data: { lastActivityAt: now, stale: false } });
}

async function createLead(input, db = prisma) {
  const email = normEmail(input.email);
  if (!isEmail(email)) throw Object.assign(new Error('invalid_email'), { status: 400 });
  if (!input.name) throw Object.assign(new Error('name_required'), { status: 400 });
  const lead = await db.lead.create({
    data: {
      name: String(input.name).trim(),
      email,
      phone: input.phone || null,
      company: input.company || null,
      source: input.source || null,
      tags: normTags(input.tags),
      notes: input.notes || null,
      owner: input.owner || null,
      unsubToken: newToken(),
    },
  });
  await db.activity.create({ data: { leadId: lead.id, type: 'CREATED', data: { source: lead.source } } });
  return lead;
}

function normTags(tags) {
  if (!tags) return [];
  const arr = Array.isArray(tags) ? tags : String(tags).split(/[,;|]/);
  return [...new Set(arr.map((t) => String(t).trim()).filter(Boolean))];
}

async function changeStage(leadId, stage, { reason = 'manual', db = prisma, now = new Date() } = {}) {
  if (!STAGES.includes(stage)) throw Object.assign(new Error('invalid_stage'), { status: 400 });
  const lead = await db.lead.findUnique({ where: { id: leadId } });
  if (!lead) throw Object.assign(new Error('not_found'), { status: 404 });
  if (lead.stage === stage) return lead;
  const updated = await db.lead.update({ where: { id: leadId }, data: { stage } });
  await logActivity(leadId, 'STAGE_CHANGED', { from: lead.stage, to: stage, reason }, db, now);
  return updated;
}

// Move forward only (never regress, never touch WON/LOST).
async function advanceStageTo(leadId, target, reason, db = prisma, now = new Date()) {
  const lead = await db.lead.findUnique({ where: { id: leadId } });
  if (!lead || ['WON', 'LOST'].includes(lead.stage)) return;
  if (stageRank(target) > stageRank(lead.stage)) await changeStage(leadId, target, { reason, db, now });
}

async function stopEnrollments(leadId, reason, db = prisma) {
  const active = await db.enrollment.findMany({ where: { leadId, status: 'ACTIVE' } });
  if (!active.length) return 0;
  await db.enrollment.updateMany({ where: { leadId, status: 'ACTIVE' }, data: { status: 'STOPPED', stopReason: reason, nextRunAt: null } });
  await db.emailMessage.updateMany({ where: { leadId, status: 'QUEUED' }, data: { status: 'CANCELLED', lastError: reason } });
  return active.length;
}

async function markReplied(leadId, { source = 'manual', db = prisma, now = new Date() } = {}) {
  await db.lead.update({ where: { id: leadId }, data: { replied: true } });
  await logActivity(leadId, 'EMAIL_REPLIED', { source }, db, now);
  await stopEnrollments(leadId, 'replied', db);
  await advanceStageTo(leadId, 'ENGAGED', 'auto:reply', db, now);
}

async function unsubscribe(token, db = prisma) {
  const lead = await db.lead.findUnique({ where: { unsubToken: token } });
  if (!lead) return null;
  if (!lead.unsubscribed) {
    await db.lead.update({ where: { id: lead.id }, data: { unsubscribed: true } });
    await logActivity(lead.id, 'UNSUBSCRIBED', null, db);
    await stopEnrollments(lead.id, 'unsubscribed', db);
  }
  return lead;
}

module.exports = {
  STAGES, stageRank, normEmail, isEmail, normTags, newToken,
  logActivity, createLead, changeStage, advanceStageTo, stopEnrollments, markReplied, unsubscribe,
};
