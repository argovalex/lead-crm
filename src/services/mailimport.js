const { simpleParser } = require('mailparser');
const prisma = require('../db');
const leads = require('./leads');
const config = require('../config');

const ownDomains = () => {
  const set = new Set(['alargov.com']);
  for (const v of [config.adminEmail, config.emailReplyTo, config.emailFrom]) {
    const m = String(v || '').match(/@([a-z0-9.-]+)/i);
    if (m) set.add(m[1].toLowerCase());
  }
  return set;
};
const domainOf = (a) => String(a || '').split('@')[1] || '';

// Splits an mbox file into raw messages (a "From " line after a blank line starts a new one).
function splitMbox(buf) {
  const text = buf.toString('latin1');
  const parts = text.split(/\r?\n(?=From [^\r\n]*\d{4}\r?\n)/).map((p) => p.replace(/^From [^\r\n]*\r?\n/, ''));
  return parts.filter((p) => p.trim()).map((p) => Buffer.from(p, 'latin1'));
}

function rawMessages(file) {
  const name = String(file.originalname || '').toLowerCase();
  if (name.endsWith('.mbox') || (!name.endsWith('.eml') && file.buffer.slice(0, 5).toString() === 'From ')) return splitMbox(file.buffer);
  return [file.buffer];
}

const clip = (s, n) => String(s || '').replace(/\r\n/g, '\n').trim().slice(0, n);
// Drops quoted history so the timeline shows only what was written.
const stripQuoted = (t) => t.split('\n').filter((l) => !/^\s*>/.test(l)).join('\n').replace(/\n(On .+ wrote:|בתאריך .+ כתב.*)[\s\S]*$/, '').trim();

// Imports mail sent by hand (EML/MBOX exported from Gmail or any client): one timeline entry per
// external recipient, with the real date. Creates missing leads. Skips duplicates by Message-ID.
async function importSent(files, { source = 'manual outreach' } = {}) {
  const own = ownDomains();
  const res = { messages: 0, logged: 0, created: 0, skipped: [], invalid: [] };
  for (const file of files) {
    for (const raw of rawMessages(file)) {
      res.messages += 1;
      let m;
      try { m = await simpleParser(raw); } catch (e) { res.invalid.push({ file: file.originalname, reason: 'unparseable' }); continue; }
      const from = leads.normEmail(((m.from && m.from.value[0]) || {}).address);
      const label = m.subject || file.originalname;
      if (!own.has(domainOf(from))) { res.skipped.push({ label, reason: 'not_sent_by_you' }); continue; }
      const rcpts = [...((m.to && m.to.value) || []), ...((m.cc && m.cc.value) || [])]
        .map((a) => ({ email: leads.normEmail(a.address), name: a.name }))
        .filter((a) => leads.isEmail(a.email) && !own.has(domainOf(a.email)));
      if (!rcpts.length) { res.skipped.push({ label, reason: 'no_external_recipient' }); continue; }
      const body = clip(stripQuoted(m.text || ''), 20000);
      const messageId = m.messageId || null;
      for (const r of rcpts) {
        try {
          const lead = await prisma.lead.findUnique({ where: { email: r.email } });
          if (lead) {
            const dup = messageId
              ? await prisma.activity.findFirst({ where: { leadId: lead.id, type: 'MANUAL_EMAIL_OUT', data: { path: ['messageId'], equals: messageId } } })
              : await prisma.activity.findFirst({ where: { leadId: lead.id, type: 'MANUAL_EMAIL_OUT', createdAt: m.date || undefined, data: { path: ['subject'], equals: m.subject || '' } } });
            if (dup) { res.skipped.push({ label, email: r.email, reason: 'already_logged' }); continue; }
          }
          const out = await leads.logInteractionByEmail({
            email: r.email, name: r.name, kind: 'EMAIL_OUT', at: m.date ? m.date.toISOString() : undefined,
            subject: m.subject || '', body, messageId, source, backfill: true,
          });
          res.logged += 1;
          if (out.created) res.created += 1;
        } catch (e) { res.invalid.push({ file: file.originalname, email: r.email, reason: e.message }); }
      }
    }
  }
  return res;
}

module.exports = { importSent };
