const express = require('express');
const prisma = require('../db');
const config = require('../config');
const settings = require('../services/settings');
const { getProvider } = require('../services/provider');
const { renderRich, renderPlain, htmlToText } = require('../services/render');
const { VARIABLES, merge, parseCsv, importRows } = require('../services/gmdss');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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
  res.json(await prisma.gmdssLead.findMany({ orderBy: { id: 'asc' } }));
}));

// Idempotent CSV import (same logic as scripts/import-gmdss.js). Body: { csv: "<file text>" }.
router.post('/import', wrap(async (req, res) => {
  const csv = req.body && req.body.csv;
  if (typeof csv !== 'string' || !csv.trim()) throw bad('csv_required');
  let rows;
  try { rows = parseCsv(csv); } catch { throw bad('invalid_csv'); }
  res.json(await importRows(prisma, rows));
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
  const { ids, subject, body, includeSent } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) throw bad('no_leads_selected');
  if (!subject || !body) throw bad('subject_and_body_required');
  if (notConfigured()) return res.status(503).json({ error: 'email_not_configured', message: NOT_CONFIGURED_MSG });
  if (sending) throw bad('send_in_progress', 409);

  const rows = await prisma.gmdssLead.findMany({ where: { id: { in: ids.map(Number).filter(Number.isInteger) } }, orderBy: { id: 'asc' } });
  const eligible = rows.filter((l) => l.email && EMAIL_RE.test(l.email) && (includeSent || l.emailStatus !== 'sent'));
  if (!eligible.length) throw bad('nothing_to_send');
  const skipped = rows.length - eligible.length;

  const stamp = Date.now();
  await prisma.gmdssLead.updateMany({ where: { id: { in: eligible.map((l) => l.id) } }, data: { emailStatus: 'queued', lastError: null } });
  sending = true;
  (async () => {
    const gap = Math.ceil(60000 / Math.max(1, config.sendsPerMinute));
    try {
      for (const [i, l] of eligible.entries()) {
        if (i) await sleep(gap);
        try {
          const b = await build(l, subject, body);
          await getProvider().send({ to: l.email, subject: b.subject, html: b.html, text: b.text, idempotencyKey: `gmdss:${l.id}:${stamp}` });
          await prisma.gmdssLead.update({ where: { id: l.id }, data: { emailStatus: 'sent', lastEmailedAt: new Date(), lastError: null } });
        } catch (e) {
          await prisma.gmdssLead.update({ where: { id: l.id }, data: { emailStatus: 'failed', lastError: String(e.message).slice(0, 300) } });
        }
      }
    } finally { sending = false; }
  })();
  res.status(202).json({ queued: eligible.length, skipped, perMinute: config.sendsPerMinute });
}));

module.exports = router;
