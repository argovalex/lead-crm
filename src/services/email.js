const prisma = require('../db');
const config = require('../config');
const { getProvider } = require('./provider');
const leads = require('./leads');
const settings = require('./settings');
const { esc, renderRich, renderPlain, htmlToText } = require('./render');

const DAY = 24 * 60 * 60 * 1000;
const STUCK_MS = 10 * 60 * 1000; // a SENDING message older than this is retried with the same idempotency key
const MAX_ATTEMPTS = 5;

function renderVars(tpl, lead) {
  const firstName = (lead.name || '').split(/\s+/)[0] || '';
  const vars = { name: lead.name || '', first_name: firstName, company: lead.company || '', email: lead.email };
  return String(tpl).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (k in vars ? vars[k] : ''));
}

function unsubUrl(lead) {
  return `${config.appUrl}/u/${lead.unsubToken}`;
}

function buildEmail(lead, subject, body, opts = {}) {
  const url = unsubUrl(lead);
  const s = renderVars(subject, lead);
  const b = renderVars(body, lead);
  const sig = opts.signatureHtml || '';
  const html = `<div dir="ltr" style="text-align:left;font-family:Arial,sans-serif;font-size:15px;line-height:1.6">`
    + renderRich(b)
    + (sig ? `<div style="margin-top:20px">${sig}</div>` : '')
    + `<hr style="border:none;border-top:1px solid #ddd;margin:24px 0 8px"><p style="font-size:12px;color:#888">`
    + `<a href="${url}" style="color:#888">Unsubscribe</a></p></div>`;
  const text = `${renderPlain(b)}${sig ? `\n\n${htmlToText(sig)}` : ''}\n\n--\nUnsubscribe: ${url}`;
  const headers = { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
  return { subject: s, html, text, headers };
}

function canEmail(lead) {
  return !lead.unsubscribed && !lead.bounced;
}

// Queue a one-off email. Sent by the dispatcher (throttled, capped).
async function queueSingle(leadId, subject, body, db = prisma) {
  const lead = await db.lead.findUnique({ where: { id: leadId } });
  if (!lead) throw Object.assign(new Error('not_found'), { status: 404 });
  if (!canEmail(lead)) throw Object.assign(new Error(lead.unsubscribed ? 'lead_unsubscribed' : 'lead_bounced'), { status: 409 });
  if (!subject || !body) throw Object.assign(new Error('subject_and_body_required'), { status: 400 });
  return db.emailMessage.create({
    data: { leadId, subject, body, idempotencyKey: `single:${leadId}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}` },
  });
}

async function enroll(leadId, sequenceId, now = new Date(), db = prisma) {
  const lead = await db.lead.findUnique({ where: { id: leadId } });
  if (!lead) throw Object.assign(new Error('not_found'), { status: 404 });
  if (!canEmail(lead)) throw Object.assign(new Error('lead_not_emailable'), { status: 409 });
  const seq = await db.sequence.findUnique({ where: { id: sequenceId }, include: { steps: { orderBy: { index: 'asc' } } } });
  if (!seq || !seq.steps.length) throw Object.assign(new Error('sequence_not_found_or_empty'), { status: 404 });
  const existing = await db.enrollment.findUnique({ where: { leadId_sequenceId: { leadId, sequenceId } } });
  if (existing) throw Object.assign(new Error('already_enrolled'), { status: 409 });
  const enr = await db.enrollment.create({
    data: { leadId, sequenceId, nextStepIndex: 0, nextRunAt: new Date(now.getTime() + seq.steps[0].delayDays * DAY), startedAt: now },
  });
  await leads.logActivity(leadId, 'SEQUENCE_ENROLLED', { sequenceId, name: seq.name }, db, now);
  return enr;
}

// Phase 1: turn due sequence steps into QUEUED messages.
// Idempotent: the unique idempotencyKey (enrollment+step) plus a conditional update on
// nextStepIndex mean a step is materialized exactly once, even across restarts or overlapping ticks.
async function materializeDueSteps(now = new Date(), db = prisma) {
  const due = await db.enrollment.findMany({
    where: { status: 'ACTIVE', nextRunAt: { lte: now } },
    include: { lead: true, sequence: { include: { steps: { orderBy: { index: 'asc' } } } } },
    take: 500,
  });
  let created = 0;
  const initialStatus = (await settings.getAll(db)).requireApproval ? 'DRAFT' : 'QUEUED';
  for (const enr of due) {
    const { lead } = enr;
    const steps = enr.sequence.steps;
    if (!canEmail(lead) || lead.replied) {
      await leads.stopEnrollments(lead.id, lead.unsubscribed ? 'unsubscribed' : lead.bounced ? 'bounced' : 'replied', db);
      continue;
    }
    const step = steps.find((s) => s.index === enr.nextStepIndex);
    if (!step) {
      await db.enrollment.updateMany({ where: { id: enr.id, status: 'ACTIVE' }, data: { status: 'COMPLETED', nextRunAt: null } });
      continue;
    }
    const next = steps.find((s) => s.index > step.index);
    try {
      await db.$transaction(async (tx) => {
        const claim = await tx.enrollment.updateMany({
          where: { id: enr.id, status: 'ACTIVE', nextStepIndex: step.index },
          data: next
            ? { nextStepIndex: next.index, nextRunAt: new Date(now.getTime() + (next.delayDays - step.delayDays) * DAY) }
            : { nextStepIndex: step.index + 1, nextRunAt: null, status: 'COMPLETED' },
        });
        if (claim.count === 0) return; // another worker already took this step
        await tx.emailMessage.create({
          data: {
            leadId: lead.id, enrollmentId: enr.id, stepIndex: step.index,
            subject: step.subject, body: step.body, status: initialStatus, idempotencyKey: `enr:${enr.id}:step:${step.index}`,
          },
        });
        created += 1;
      });
    } catch (e) {
      if (e.code !== 'P2002') throw e; // P2002 = duplicate key: step already queued
    }
  }
  return created;
}

function startOfUtcDay(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// Phase 2: send QUEUED messages, respecting per-minute throttle and daily cap.
async function dispatch(now = new Date(), db = prisma, provider = getProvider()) {
  const sentToday = await db.emailMessage.count({ where: { sentAt: { gte: startOfUtcDay(now) } } });
  const budget = Math.max(0, Math.min(config.sendsPerMinute, config.dailySendCap - sentToday));
  if (budget === 0) return { sent: 0, failed: 0, capped: true };

  // Claim rows atomically (SKIP LOCKED) so concurrent workers never pick the same message.
  const stuckBefore = new Date(now.getTime() - STUCK_MS);
  // Prisma stores DateTime as UTC in `timestamp` columns; convert params explicitly so the DB session TimeZone can't skew them.
  const claimed = await db.$queryRaw`
    UPDATE "EmailMessage" SET status = 'SENDING', "lockedAt" = (${now}::timestamptz AT TIME ZONE 'UTC'), attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM "EmailMessage"
      WHERE (status = 'QUEUED' OR (status = 'SENDING' AND "lockedAt" < (${stuckBefore}::timestamptz AT TIME ZONE 'UTC')))
      ORDER BY "createdAt" ASC
      LIMIT ${budget}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id`;

  let sent = 0;
  let failed = 0;
  const cfg = claimed.length ? await settings.getAll(db) : null;
  for (const { id } of claimed) {
    const msg = await db.emailMessage.findUnique({ where: { id }, include: { lead: true } });
    const { lead } = msg;
    if (!canEmail(lead) || (msg.enrollmentId && lead.replied)) {
      await db.emailMessage.update({ where: { id }, data: { status: 'CANCELLED', lastError: 'lead_not_emailable' } });
      continue;
    }
    const built = buildEmail(lead, msg.subject, msg.body, cfg);
    try {
      const { providerId } = await provider.send({ to: lead.email, ...built, idempotencyKey: msg.idempotencyKey });
      await db.emailMessage.update({ where: { id }, data: { status: 'SENT', sentAt: now, providerId, lockedAt: null, subject: built.subject } });
      await leads.logActivity(lead.id, 'EMAIL_SENT', { messageId: id, subject: built.subject, step: msg.stepIndex }, db, now);
      await leads.advanceStageTo(lead.id, 'CONTACTED', 'auto:email_sent', db, now);
      if (!msg.enrollmentId) {
        // A manually written email: the "reply" task is done; schedule the next follow-up.
        await db.lead.update({ where: { id: lead.id }, data: { nextAction: 'מעקב', nextFollowUpAt: new Date(now.getTime() + 5 * DAY) } });
      }
      sent += 1;
    } catch (e) {
      const final = msg.attempts >= MAX_ATTEMPTS;
      await db.emailMessage.update({
        where: { id },
        data: { status: final ? 'FAILED' : 'QUEUED', lockedAt: null, lastError: String(e.message).slice(0, 500) },
      });
      if (final) await leads.logActivity(lead.id, 'EMAIL_FAILED', { messageId: id, error: String(e.message).slice(0, 200) }, db, now);
      failed += 1;
    }
  }
  return { sent, failed, capped: false };
}

// Plain-text body of a received email; falls back to stripped HTML. Null when unavailable.
async function fetchBody(emailId) {
  const m = await require('./provider').fetchReceived(emailId);
  if (!m) return null;
  if (m.text) return m.text.trim();
  if (m.html) return m.html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>|<\/p>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return null;
}

// Webhook event handling (Resend event shapes). Deduplicated by svix-id.
async function handleEvent(eventId, event, db = prisma, now = new Date()) {
  try {
    await db.webhookEvent.create({ data: { id: eventId, type: event.type } });
  } catch (e) {
    if (e.code === 'P2002') return { duplicate: true };
    throw e;
  }
  const d = event.data || {};

  if (event.type === 'email.received') {
    const raw = typeof d.from === 'string' ? d.from : d.from?.email || '';
    const from = leads.normEmail((raw.match(/<([^>]+)>/) || [, raw])[1]);
    const name = (raw.match(/^\s*"?([^"<]+?)"?\s*</) || [, ''])[1].trim() || undefined;
    if (!leads.isEmail(from)) return { handled: false };
    // Skip our own addresses and automatic mailer messages (bounces are handled by email.bounced).
    if (/^(mailer-daemon|postmaster|noreply|no-reply)@/.test(from) || from.endsWith('@reply.alargov.com')) return { handled: false, skipped: true };
    const body = await fetchBody(d.email_id);
    const res = await leads.logInteractionByEmail({
      email: from, name, kind: 'EMAIL_IN', at: now, subject: d.subject || null,
      body: body ? body.slice(0, 8000) : '(תוכן ההודעה לא נטען. למפתח ה-API של Resend צריכה להיות הרשאת Full access כדי לקרוא מיילים נכנסים. את ההודעה אפשר לראות ב-Resend תחת Emails, Receiving.)', source: 'inbound reply',
    }, db);
    return { handled: true, leadId: res.leadId, created: res.created };
  }

  const msg = d.email_id && (await db.emailMessage.findUnique({ where: { providerId: d.email_id } }));
  if (!msg) return { handled: await require('./gmdss').handleGmdssEvent(db, event, now) };
  const map = {
    'email.delivered': ['deliveredAt', 'EMAIL_DELIVERED'],
    'email.opened': ['openedAt', 'EMAIL_OPENED'],
    'email.clicked': ['clickedAt', 'EMAIL_CLICKED'],
    'email.bounced': ['bouncedAt', 'EMAIL_BOUNCED'],
    'email.complained': [null, 'EMAIL_COMPLAINED'],
  };
  const entry = map[event.type];
  if (!entry) return { handled: false };
  const [field, activity] = entry;
  if (field && !msg[field]) await db.emailMessage.update({ where: { id: msg.id }, data: { [field]: now } });
  await leads.logActivity(msg.leadId, activity, { messageId: msg.id, link: d.click?.link }, db, now);

  if (event.type === 'email.clicked') await leads.advanceStageTo(msg.leadId, 'ENGAGED', 'auto:click', db, now);
  if (event.type === 'email.bounced') {
    await db.lead.update({ where: { id: msg.leadId }, data: { bounced: true } });
    await leads.stopEnrollments(msg.leadId, 'bounced', db);
  }
  if (event.type === 'email.complained') {
    await db.lead.update({ where: { id: msg.leadId }, data: { unsubscribed: true } });
    await leads.stopEnrollments(msg.leadId, 'complained', db);
  }
  return { handled: true };
}

// Flag leads with no activity for STALE_DAYS (open pipeline only). Flag clears on next activity.
async function flagStale(now = new Date(), db = prisma) {
  const cutoff = new Date(now.getTime() - config.staleDays * DAY);
  const rows = await db.lead.findMany({
    where: { stale: false, lastActivityAt: { lt: cutoff }, stage: { notIn: ['WON', 'LOST'] } },
    select: { id: true },
  });
  if (!rows.length) return 0;
  const ids = rows.map((r) => r.id);
  await db.lead.updateMany({ where: { id: { in: ids } }, data: { stale: true } });
  await db.activity.createMany({ data: ids.map((leadId) => ({ leadId, type: 'STALE_FLAGGED', data: { days: config.staleDays }, createdAt: now })) });
  return ids.length;
}

module.exports = { renderVars, buildEmail, queueSingle, enroll, materializeDueSteps, dispatch, handleEvent, flagStale, DAY };
