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
      country: input.country || null,
      segment: input.segment || null,
      priority: input.priority || null,
      website: input.website || null,
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
  await db.emailMessage.updateMany({ where: { leadId, status: { in: ['QUEUED', 'DRAFT'] } }, data: { status: 'CANCELLED', lastError: reason } });
  return active.length;
}

async function markReplied(leadId, { source = 'manual', db = prisma, now = new Date() } = {}) {
  await db.lead.update({ where: { id: leadId }, data: { replied: true } });
  await logActivity(leadId, 'EMAIL_REPLIED', { source }, db, now);
  await stopEnrollments(leadId, 'replied', db);
  await advanceStageTo(leadId, 'ENGAGED', 'auto:reply', db, now);
}

// ---- Manual interactions (emails sent/received outside the system, SMS, calls, meetings) ----
const INTERACTIONS = {
  EMAIL_OUT: { dir: 'out', act: 'MANUAL_EMAIL_OUT' },
  EMAIL_IN: { dir: 'in', act: 'REPLY_IN' },
  SMS_OUT: { dir: 'out', act: 'SMS_OUT' },
  SMS_IN: { dir: 'in', act: 'SMS_IN' },
  CALL: { dir: 'out', act: 'CALL' },
  MEETING: { dir: 'out', act: 'MEETING' },
};
const DAY = 24 * 60 * 60 * 1000;

// Records an interaction with its real date, moves the stage forward, and manages the follow-up
// reminder: inbound -> "reply" due in 2 days; outbound mail/SMS -> follow-up in 5 days; call or
// meeting -> clears it. The caller can override with followUpAt / followUpDays / nextAction.
async function logInteraction(leadId, input, db = prisma) {
  const spec = INTERACTIONS[input.kind];
  if (!spec) throw Object.assign(new Error('invalid_kind'), { status: 400 });
  const lead = await db.lead.findUnique({ where: { id: leadId } });
  if (!lead) throw Object.assign(new Error('not_found'), { status: 404 });
  const at = input.at ? new Date(input.at) : new Date();
  if (Number.isNaN(at.getTime())) throw Object.assign(new Error('invalid_date'), { status: 400 });
  const data = { subject: input.subject || null, body: input.body || null, manual: true };
  await db.activity.create({ data: { leadId, type: spec.act, data, createdAt: at } });
  const upd = { lastActivityAt: lead.lastActivityAt > at ? lead.lastActivityAt : at, stale: false };
  if (spec.dir === 'in') {
    upd.replied = true;
    upd.nextAction = 'להשיב';
    upd.nextFollowUpAt = new Date(at.getTime() + 2 * DAY);
  } else if (input.kind === 'EMAIL_OUT' || input.kind === 'SMS_OUT') {
    upd.nextAction = 'מעקב';
    upd.nextFollowUpAt = new Date(at.getTime() + 5 * DAY);
  } else {
    upd.nextAction = null;
    upd.nextFollowUpAt = null;
  }
  if (input.followUpAt) {
    upd.nextFollowUpAt = new Date(input.followUpAt);
    if (input.nextAction) upd.nextAction = input.nextAction;
  } else if (input.followUpDays != null && input.followUpDays !== '') {
    upd.nextFollowUpAt = new Date(at.getTime() + Number(input.followUpDays) * DAY);
  }
  await db.lead.update({ where: { id: leadId }, data: upd });
  if (spec.dir === 'in') {
    await stopEnrollments(leadId, 'replied', db);
    await advanceStageTo(leadId, 'ENGAGED', 'auto:reply', db, at);
  } else if (input.kind === 'EMAIL_OUT' || input.kind === 'SMS_OUT') {
    await advanceStageTo(leadId, 'CONTACTED', 'auto:manual_outreach', db, at);
  }
  return db.lead.findUnique({ where: { id: leadId } });
}

// Same, addressed by email; creates the lead when unknown (e.g. a reply from a new contact).
async function logInteractionByEmail(input, db = prisma) {
  const email = normEmail(input.email);
  if (!isEmail(email)) throw Object.assign(new Error('invalid_email'), { status: 400 });
  let lead = await db.lead.findUnique({ where: { email } });
  let created = false;
  if (!lead) {
    lead = await createLead({
      name: input.name || input.company || email.split('@')[0], email, company: input.company,
      source: input.source || 'manual outreach', tags: input.tags, country: input.country,
      segment: input.segment, priority: input.priority, phone: input.phone, notes: input.notes,
    }, db);
    created = true;
  }
  await logInteraction(lead.id, input, db);
  return { leadId: lead.id, created };
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
  logActivity, logInteraction, logInteractionByEmail, INTERACTIONS, createLead, changeStage, advanceStageTo, stopEnrollments, markReplied, unsubscribe,
};
