const express = require('express');
const prisma = require('../db');
const config = require('../config');
const settings = require('../services/settings');
const { getProvider } = require('../services/provider');
const { renderRich, renderPlain, htmlToText } = require('../services/render');
const { suggestReply } = require('../services/suggest');
const reminders = require('../services/gmdssReminders');
const { VARIABLES, merge, parseCsv, importRows, logActivity, syncReplies } = require('../services/gmdss');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FUP_DAYS = 7; // default follow-up after a send; editable per lead in the customer card
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SAMPLE = {
  organization: 'Sample Maritime Academy', country: 'Greece', segment: 'Maritime Academy', productFit: 'Both',
  whyTheydBuy: 'Trains deck officers for GMDSS certificates', website: 'https://example.com', email: 'sample@example.com',
  phone: '+30 210 000 0000', priority: 'A',
};

const notConfigured = () => config.emailProvider !== 'mock' && (!config.resendApiKey || !config.emailFrom);
const NOT_CONFIGURED_MSG = 'שליחת מייל לא מוגדרת: חסרים משתני סביבה RESEND_API_KEY ו-EMAIL_FROM (דומיין מאומת ב-Resend).';

async function build(lead, subject, body) {
  const s = merge(subject, lead);
  const b = merge(body, lead);
  const sig = (await settings.getAll()).signatureHtml || '';
  const html = `<div dir="ltr" style="text-align:left;font-family:Arial,sans-serif;font-size:15px;line-height:1.6">`
    + renderRich(b.text) + (sig ? `<div style="margin-top:20px">${sig}</div>` : '')
    + `<p style="font-size:12px;color:#888;margin-top:24px">Not interested? Reply "unsubscribe" and we will not contact you again.</p></div>`;
  const text = `${renderPlain(b.text)}${sig ? `\n\n${htmlToText(sig)}` : ''}\n\n--\nNot interested? Reply "unsubscribe".`;
  return { subject: s.text, html, text, unknown: [...new Set([...s.unknown, ...b.unknown])] };
}

router.get('/variables', (_req, res) => res.json({ variables: VARIABLES, emailConfigured: !notConfigured(), setupMessage: notConfigured() ? NOT_CONFIGURED_MSG : null }));

router.get('/leads', wrap(async (_req, res) => {
  try { await syncReplies(prisma); } catch (e) { console.error('gmdss reply sync failed', e.message); }
  res.json(await prisma.gmdssLead.findMany({ orderBy: { id: 'asc' }, include: { template: { select: { id: true, name: true } } } }));
}));

// Edit a lead. Changing the email address resets the send state so the corrected address can be mailed again.
const EDITABLE = ['organization', 'country', 'segment', 'productFit', 'whyTheydBuy', 'website', 'email', 'phone', 'priority'];
router.put('/leads/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const cur = await prisma.gmdssLead.findUnique({ where: { id } });
  if (!cur) throw bad('not_found', 404);
  const data = {};
  for (const k of EDITABLE) {
    if (!(k in (req.body || {}))) continue;
    const v = String(req.body[k] ?? '').trim();
    data[k] = v || null;
  }
  if ('organization' in data && !data.organization) throw bad('organization_required');
  if (data.email) {
    data.email = data.email.toLowerCase();
    if (!EMAIL_RE.test(data.email)) throw bad('invalid_email');
  }
  if (data.priority && !['A', 'B', 'C'].includes(data.priority)) throw bad('priority_must_be_A_B_or_C');
  if ('followUpAt' in (req.body || {})) {
    const f = req.body.followUpAt ? new Date(req.body.followUpAt) : null;
    if (f && Number.isNaN(f.getTime())) throw bad('invalid_follow_up_date');
    data.followUpAt = f;
  }
  if ('notes' in (req.body || {})) data.notes = String(req.body.notes || '').trim() || null;
  if ('email' in data && data.email !== (cur.email || null)) {
    Object.assign(data, { emailStatus: 'not_sent', lastError: null, lastEmailedAt: null, providerId: null, deliveredAt: null, openedAt: null, clickedAt: null, bouncedAt: null, lastClickLink: null, openCount: 0, clickCount: 0 });
  }
  let out;
  try { out = await prisma.gmdssLead.update({ where: { id }, data, include: { template: { select: { id: true, name: true } } } }); }
  catch (e) { if (e.code === 'P2002') throw bad('duplicate_lead', 409); throw e; }
  const changed = [...EDITABLE, 'notes'].filter((k) => k in data && (data[k] ?? null) !== (cur[k] ?? null));
  if (changed.includes('email')) await logActivity(prisma, id, 'email_changed', `${cur.email || '(none)'} -> ${data.email || '(none)'} (send status reset)`);
  const other = changed.filter((k) => k !== 'email' && k !== 'notes');
  if (other.length) await logActivity(prisma, id, 'edited', other.join(', '));
  if ('followUpAt' in data && String(data.followUpAt || '') !== String(cur.followUpAt || '')) {
    await logActivity(prisma, id, 'follow_up', data.followUpAt ? `Follow-up set for ${data.followUpAt.toISOString().slice(0, 10)}` : 'Follow-up cleared');
  }
  res.json(out);
}));

// Conversation history for a lead as {dir, subject, body, at} items, oldest first.
async function threadFor(lead) {
  const acts = await prisma.gmdssActivity.findMany({ where: { leadId: lead.id, type: { in: ['sent', 'replied', 'reply_sent'] } }, orderBy: { createdAt: 'asc' } });
  const tpl = lead.templateId ? await prisma.gmdssTemplate.findUnique({ where: { id: lead.templateId } }) : null;
  return acts.map((a) => {
    const d = a.detail || '';
    if (a.type === 'replied') { const [subject, ...rest] = d.split('\n'); return { dir: 'in', subject, body: rest.join('\n'), at: a.createdAt }; }
    if (a.type === 'reply_sent') { const [subject, ...rest] = d.split('\n'); return { dir: 'out', subject, body: rest.join('\n'), at: a.createdAt }; }
    return { dir: 'out', subject: d.replace(/\s+\[template:.*$/, ''), body: tpl ? merge(tpl.body, lead).text : '', at: a.createdAt };
  });
}

// Draft a reply (or a follow-up when the lead has not answered) for the card's reply box.
router.post('/leads/:id/suggest', wrap(async (req, res) => {
  try { await syncReplies(prisma); } catch (e) { console.error('gmdss reply sync failed', e.message); }
  const lead = await prisma.gmdssLead.findUnique({ where: { id: Number(req.params.id) } });
  if (!lead) throw bad('not_found', 404);
  const items = await threadFor(lead);
  if (!items.length) throw bad('no_conversation_yet');
  res.json(await suggestReply({ name: lead.organization, company: lead.country }, items, { followUp: true }));
}));

// Send a one-to-one reply from the card and keep it in the timeline. Pushes the follow-up date out by the default.
router.post('/leads/:id/reply', wrap(async (req, res) => {
  const lead = await prisma.gmdssLead.findUnique({ where: { id: Number(req.params.id) } });
  if (!lead) throw bad('not_found', 404);
  if (!lead.email || !EMAIL_RE.test(lead.email)) throw bad('lead_has_no_email');
  const subject = String((req.body && req.body.subject) || '').trim();
  const text = String((req.body && req.body.body) || '').trim();
  if (!subject || !text) throw bad('subject_and_body_required');
  if (notConfigured()) return res.status(503).json({ error: 'email_not_configured', message: NOT_CONFIGURED_MSG });
  const sig = (await settings.getAll()).signatureHtml || '';
  const html = `<div dir="ltr" style="text-align:left;font-family:Arial,sans-serif;font-size:15px;line-height:1.6">${renderRich(text)}${sig ? `<div style="margin-top:20px">${sig}</div>` : ''}</div>`;
  const plain = `${renderPlain(text)}${sig ? `\n\n${htmlToText(sig)}` : ''}`;
  await getProvider().send({ to: lead.email, subject, html, text: plain, idempotencyKey: `gmdss-reply:${lead.id}:${Date.now()}` });
  await logActivity(prisma, lead.id, 'reply_sent', `${subject}\n${text}`);
  await prisma.gmdssLead.update({ where: { id: lead.id }, data: { followUpAt: new Date(Date.now() + FUP_DAYS * 86400000) } });
  res.json({ sentTo: lead.email });
}));

// ---------- Reminders (opens/clicks drive the wording) and access codes ----------
router.get('/reminders', wrap(async (_req, res) => {
  const due = await reminders.dueLeads();
  res.json({
    enabled: await reminders.isEnabled(), max: reminders.MAX_REMINDERS, waitDays: reminders.WAIT_DAYS, dailyCap: reminders.DAILY_CAP,
    inWindow: reminders.inSendWindow(), emailConfigured: !notConfigured(),
    due: due.map(({ l, d }) => ({ id: l.id, organization: l.organization, email: l.email, segment: d.segment, n: d.n, openCount: l.openCount, clickCount: l.clickCount, dueAt: d.dueAt })),
  });
}));
router.put('/reminders', wrap(async (req, res) => {
  await reminders.setEnabled(!!(req.body && req.body.enabled));
  res.json({ enabled: await reminders.isEnabled() });
}));
router.post('/reminders/run', wrap(async (_req, res) => {
  if (notConfigured()) return res.status(503).json({ error: 'email_not_configured', message: NOT_CONFIGURED_MSG });
  res.json(await reminders.runDue(new Date(), { ignoreWindow: true }));
}));
router.post('/leads/:id/remind', wrap(async (req, res) => {
  if (notConfigured()) return res.status(503).json({ error: 'email_not_configured', message: NOT_CONFIGURED_MSG });
  const r = await reminders.sendReminder(Number(req.params.id), { force: true });
  if (r.failed) throw bad(r.error, 502);
  res.json(r);
}));
router.post('/leads/:id/code', wrap(async (req, res) => {
  if (notConfigured()) return res.status(503).json({ error: 'email_not_configured', message: NOT_CONFIGURED_MSG });
  res.json(await reminders.sendCode(Number(req.params.id), { code: req.body && req.body.code, note: req.body && req.body.note }));
}));

// Customer card: activity timeline + manual notes.
router.get('/leads/:id/activities', wrap(async (req, res) => {
  try { await syncReplies(prisma); } catch (e) { console.error('gmdss reply sync failed', e.message); }
  res.json(await prisma.gmdssActivity.findMany({ where: { leadId: Number(req.params.id) }, orderBy: { createdAt: 'desc' }, take: 300 }));
}));
router.post('/leads/:id/activities', wrap(async (req, res) => {
  const detail = String((req.body && req.body.detail) || '').trim();
  if (!detail) throw bad('detail_required');
  const id = Number(req.params.id);
  if (!(await prisma.gmdssLead.findUnique({ where: { id } }))) throw bad('not_found', 404);
  res.status(201).json(await logActivity(prisma, id, 'note', detail));
}));

// Idempotent CSV import (same logic as scripts/import-gmdss.js). Body: { csv: "<file text>" }.
router.post('/import', wrap(async (req, res) => {
  const csv = req.body && req.body.csv;
  if (typeof csv !== 'string' || !csv.trim()) throw bad('csv_required');
  let rows;
  try { rows = parseCsv(csv); } catch { throw bad('invalid_csv'); }
  res.json(await importRows(prisma, rows));
}));

// ---------- Templates ----------
router.get('/templates', wrap(async (_req, res) => { res.json(await prisma.gmdssTemplate.findMany({ orderBy: { id: 'asc' } })); }));
const tplData = (b) => {
  const name = String((b && b.name) || '').trim(), subject = String((b && b.subject) || '').trim(), body = String((b && b.body) || '').trim();
  if (!name || !subject || !body) throw bad('name_subject_body_required');
  return { name, subject, body };
};
router.post('/templates', wrap(async (req, res) => { res.status(201).json(await prisma.gmdssTemplate.create({ data: tplData(req.body) })); }));
router.put('/templates/:id', wrap(async (req, res) => { res.json(await prisma.gmdssTemplate.update({ where: { id: Number(req.params.id) }, data: tplData(req.body) })); }));
router.delete('/templates/:id', wrap(async (req, res) => { await prisma.gmdssTemplate.delete({ where: { id: Number(req.params.id) } }); res.json({ ok: true }); }));

// Attach a template to leads without sending.
router.post('/assign', wrap(async (req, res) => {
  const { ids, templateId } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) throw bad('no_leads_selected');
  const n = await prisma.gmdssLead.updateMany({ where: { id: { in: ids.map(Number).filter(Number.isInteger) } }, data: { templateId: templateId ? Number(templateId) : null } });
  if (templateId) {
    const t = await prisma.gmdssTemplate.findUnique({ where: { id: Number(templateId) } });
    for (const id of ids.map(Number).filter(Number.isInteger)) await logActivity(prisma, id, 'template', `Attached template: ${t ? t.name : templateId}`);
  }
  res.json({ updated: n.count });
}));

router.post('/preview', wrap(async (req, res) => {
  const { subject, body, leadId } = req.body || {};
  const lead = leadId ? await prisma.gmdssLead.findUnique({ where: { id: Number(leadId) } }) : null;
  const b = await build(lead || SAMPLE, subject || '', body || '');
  res.json({ subject: b.subject, html: b.html, text: b.text, unknown: b.unknown, sample: !lead });
}));

router.post('/test-email', wrap(async (req, res) => {
  const { subject, body, leadId, to } = req.body || {};
  if (!subject || !body) throw bad('subject_and_body_required');
  if (!EMAIL_RE.test(String(to || '').trim())) throw bad('invalid_email');
  if (notConfigured()) return res.status(503).json({ error: 'email_not_configured', message: NOT_CONFIGURED_MSG });
  const lead = leadId ? await prisma.gmdssLead.findUnique({ where: { id: Number(leadId) } }) : null;
  const b = await build(lead || SAMPLE, subject, body);
  const { providerId } = await getProvider().send({
    to: String(to).trim(), subject: `[בדיקה] ${b.subject}`, html: b.html, text: b.text,
    idempotencyKey: `gmdss-test:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
  });
  res.json({ sentTo: String(to).trim(), providerId });
}));

// Real send: one email per lead, throttled, runs in the background; the UI polls /leads.
let sending = false;
router.get('/send/status', (_req, res) => res.json({ sending }));

router.post('/send', wrap(async (req, res) => {
  const { ids, includeSent, templateId } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) throw bad('no_leads_selected');
  const tpl = templateId ? await prisma.gmdssTemplate.findUnique({ where: { id: Number(templateId) } }) : null;
  if (!tpl) throw bad('template_required');
  const { subject, body } = tpl;
  if (notConfigured()) return res.status(503).json({ error: 'email_not_configured', message: NOT_CONFIGURED_MSG });
  if (sending) throw bad('send_in_progress', 409);

  const rows = await prisma.gmdssLead.findMany({ where: { id: { in: ids.map(Number).filter(Number.isInteger) } }, orderBy: { id: 'asc' } });
  const eligible = rows.filter((l) => l.email && EMAIL_RE.test(l.email) && (includeSent || l.emailStatus !== 'sent'));
  if (!eligible.length) throw bad('nothing_to_send');
  const skipped = rows.length - eligible.length;

  const stamp = Date.now();
  await prisma.gmdssLead.updateMany({ where: { id: { in: eligible.map((l) => l.id) } }, data: { emailStatus: 'queued', lastError: null, templateId: tpl.id } });
  sending = true;
  (async () => {
    const gap = Math.ceil(60000 / Math.max(1, config.sendsPerMinute));
    try {
      for (const [i, l] of eligible.entries()) {
        if (i) await sleep(gap);
        try {
          const b = await build(l, subject, body);
          const { providerId } = await getProvider().send({ to: l.email, subject: b.subject, html: b.html, text: b.text, idempotencyKey: `gmdss:${l.id}:${stamp}` });
          await prisma.gmdssLead.update({ where: { id: l.id }, data: { emailStatus: 'sent', lastEmailedAt: new Date(), lastError: null, providerId, deliveredAt: null, openedAt: null, clickedAt: null, bouncedAt: null, lastClickLink: null, openCount: 0, clickCount: 0, followUpAt: new Date(Date.now() + FUP_DAYS * 86400000) } });
          await logActivity(prisma, l.id, 'sent', `${b.subject}  [template: ${tpl.name}]`);
        } catch (e) {
          await prisma.gmdssLead.update({ where: { id: l.id }, data: { emailStatus: 'failed', lastError: String(e.message).slice(0, 300) } });
          await logActivity(prisma, l.id, 'failed', String(e.message).slice(0, 300));
        }
      }
    } finally { sending = false; }
  })();
  res.status(202).json({ queued: eligible.length, skipped, perMinute: config.sendsPerMinute });
}));

module.exports = router;
