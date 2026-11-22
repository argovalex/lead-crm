// GMDSS outreach: CSV parsing, contact splitting, import, merge-field rendering.
const { parseEmails } = require('./emails');
const { parse } = require('csv-parse/sync');

// Variable names are exactly the CSV headings (case-sensitive).
const VARIABLES = ['Organization', 'Contact', 'Country', 'Segment', 'Product Fit', "Why They'd Buy", 'Website', 'Email', 'Phone', 'Priority'];

const clean = (v) => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
};

// "a@b.com / +33 4 93" -> { email, phone }. Detect by pattern, not position.
function splitContact(raw) {
  const out = { email: null, phone: null };
  for (const tok of String(raw ?? '').split(' / ').map((t) => t.trim()).filter(Boolean)) {
    if (tok.includes('@')) out.email = out.email || tok;
    else if (/^[+\d]/.test(tok)) out.phone = out.phone || tok;
  }
  return out;
}

function parseCsv(text) {
  const rows = parse(text, { columns: true, skip_empty_lines: true, bom: true, trim: false });
  return rows.map((r) => {
    const { email, phone } = splitContact(r['Contact Email / Phone']);
    return {
      organization: clean(r['Organization']),
      contactName: clean(r['Contact Name'] ?? r['Contact']),
      country: clean(r['Country']),
      segment: clean(r['Segment']),
      productFit: clean(r['Product Fit']),
      whyTheydBuy: clean(r["Why They'd Buy"]),
      website: clean(r['Website']),
      email,
      phone,
      priority: clean(r['Priority']),
    };
  });
}

// Idempotent: a row is a duplicate if the email matches (case-insensitive) or,
// with no email, organization+country matches. Never merges or deletes.
async function importRows(prisma, rows) {
  const stats = { read: rows.length, inserted: 0, duplicates: 0, noEmail: 0, noPhone: 0 };
  for (const r of rows) {
    if (!r.email) stats.noEmail += 1;
    if (!r.phone) stats.noPhone += 1;
    if (!r.organization) throw new Error('row_without_organization');
    const existing = r.email
      ? await prisma.gmdssLead.findFirst({ where: { email: { equals: r.email, mode: 'insensitive' } } })
      : await prisma.gmdssLead.findFirst({
        where: {
          email: null,
          organization: { equals: r.organization, mode: 'insensitive' },
          country: r.country ? { equals: r.country, mode: 'insensitive' } : null,
        },
      });
    if (existing) { stats.duplicates += 1; continue; }
    await prisma.gmdssLead.create({ data: r });
    stats.inserted += 1;
  }
  return stats;
}

function valuesFor(lead) {
  return {
    Organization: lead.organization, Contact: lead.contactName ? String(lead.contactName).trim() : null, Country: lead.country, Segment: lead.segment, 'Product Fit': lead.productFit,
    "Why They'd Buy": lead.whyTheydBuy, Website: lead.website, Email: lead.email, Phone: lead.phone, Priority: lead.priority,
  };
}

// Replaces {{Heading}} with the lead's value (empty string when missing). Unknown names stay untouched and are reported.
// When the lead has a personal contact name, a leading salutation line ("Dear X team," / "Hi," / "Hello,")
// becomes "Dear <name>,". Templates stay generic; leads without a name keep the generic greeting.
const SALUTATION = /^(\s*(?:\*\*)?)(?:Dear [^\n]*|Hi|Hello),[ \t]*(?=\n|$)/;
function personalize(text, lead) {
  // "Jan Erik Duff (Global Business Development Manager)" -> "Jan Erik Duff": the role note is for the CRM, not the greeting.
  const name = String(lead.contactName ?? '').replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  return name ? text.replace(SALUTATION, (_m, pre) => `${pre}Dear ${name},`) : text;
}

function merge(tpl, lead) {
  const vals = valuesFor(lead);
  const unknown = new Set();
  const out = personalize(String(tpl ?? ''), lead).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, k) => {
    if (k in vals) return vals[k] ?? '';
    unknown.add(k);
    return m;
  });
  return { text: out, unknown: [...unknown] };
}

// Resend webhook events for emails sent from the GMDSS page. Returns true when the event belonged to a GMDSS lead.
const logActivity = (prisma, leadId, type, detail, at) =>
  prisma.gmdssActivity.create({ data: { leadId, type, detail: detail ? String(detail).slice(0, type === 'replied' || type === 'reply_sent' ? 6000 : 1000) : null, ...(at ? { createdAt: at } : {}) } });

// Mail from these providers says nothing about the organization, so a domain match would be a guess.
const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'aol.com', 'gmx.com', 'gmx.de', 'proton.me', 'protonmail.com', 'mail.com', 'zoho.com', 'yandex.com', 'walla.co.il', 'bezeqint.net', 'orange.fr', 'free.fr', 'wanadoo.fr', 'btinternet.com', 'sky.com', 'bigpond.com', 'optusnet.com.au']);

// Which GMDSS lead does an inbound reply belong to?
// 1. The exact address we mailed. 2. Someone else at the same organization (same domain, not a free-mail
// provider): the lead we emailed most recently on that domain, since that is the mail being answered.
// Returns { lead, exact } or null.
async function findReplyLead(prisma, email) {
  const addr = String(email || '').trim().toLowerCase();
  const exact = (await prisma.gmdssLead.findMany({ where: { email: { contains: addr, mode: 'insensitive' } } })).find((l) => parseEmails(l.email).includes(addr));
  if (exact) return { lead: exact, exact: true };
  const domain = addr.split('@')[1];
  if (!domain || FREE_MAIL.has(domain)) return null;
  const same = await prisma.gmdssLead.findMany({ where: { email: { contains: `@${domain}`, mode: 'insensitive' }, lastEmailedAt: { not: null } } });
  if (!same.length) return null;
  same.sort((a, b) => new Date(b.lastEmailedAt) - new Date(a.lastEmailedAt));
  return { lead: same[0], exact: false };
}

// An inbound reply for a GMDSS lead: mark the lead and add it to the timeline.
async function logReply(prisma, email, subject, body, now = new Date()) {
  const m = await findReplyLead(prisma, email);
  if (!m) return false;
  const { lead: l, exact } = m;
  await prisma.gmdssLead.update({ where: { id: l.id }, data: { repliedAt: now } });
  // A reply from a different address says so in the timeline, so it is never mistaken for the lead's own.
  const text = `${exact ? '' : `[מאת ${email}, לא הכתובת שאליה נשלח המייל]\n`}${body ? String(body).slice(0, 5000) : ''}`.trim();
  await logActivity(prisma, l.id, 'replied', `${subject || ''}${text ? `\n${text}` : ''}`.trim(), now);
  return true;
}

// Replies that the main CRM already stored (REPLY_IN) become GMDSS timeline entries, so the card and the
// reply suggestion always see what the lead actually wrote, including replies received before this existed.
async function syncReplies(prisma) {
  await syncSentMail(prisma).catch((e) => console.error('gmdss sent-mail sync failed', e.message));
  const emails = (await prisma.gmdssLead.findMany({ where: { email: { not: null } }, select: { id: true, email: true, repliedAt: true } }));
  if (!emails.length) return;
  const byEmail = new Map(emails.flatMap((l) => parseEmails(l.email).map((e) => [e, l])));
  const ins = await prisma.activity.findMany({
    where: { type: 'REPLY_IN', lead: { email: { in: [...byEmail.keys()] } } },
    include: { lead: { select: { email: true } } }, orderBy: { createdAt: 'asc' },
  });
  for (const a of ins) {
    const l = byEmail.get(a.lead.email.toLowerCase());
    if (!l) continue;
    const have = await prisma.gmdssActivity.findFirst({ where: { leadId: l.id, type: 'replied', createdAt: a.createdAt } });
    if (have) continue;
    const d = a.data || {};
    await logActivity(prisma, l.id, 'replied', `${d.subject || ''}${d.body ? `\n${String(d.body).slice(0, 5000)}` : ''}`.trim(), a.createdAt);
    if (!l.repliedAt || l.repliedAt < a.createdAt) { l.repliedAt = a.createdAt; await prisma.gmdssLead.update({ where: { id: l.id }, data: { repliedAt: a.createdAt } }); }
  }
}

// Mail Alex sent by hand from the main mail screen (#/mail, no sequence) to a GMDSS lead's address becomes a
// "reply_sent" entry in that lead's card, so one-to-one correspondence is never split between the two screens.
async function syncSentMail(prisma) {
  const emails = await prisma.gmdssLead.findMany({ where: { email: { not: null } }, select: { id: true, email: true } });
  if (!emails.length) return;
  const byEmail = new Map(emails.flatMap((l) => parseEmails(l.email).map((e) => [e, l])));
  const msgs = await prisma.emailMessage.findMany({
    where: { status: 'SENT', enrollmentId: null, sentAt: { not: null }, lead: { email: { in: [...byEmail.keys()] } } },
    include: { lead: { select: { email: true } } }, orderBy: { sentAt: 'asc' },
  });
  for (const m of msgs) {
    const l = byEmail.get(m.lead.email.toLowerCase());
    if (!l) continue;
    if (await prisma.gmdssActivity.findFirst({ where: { leadId: l.id, type: 'reply_sent', createdAt: m.sentAt } })) continue;
    await logActivity(prisma, l.id, 'reply_sent', `${m.subject || ''}
${String(m.body || '').slice(0, 5000)}`.trim(), m.sentAt);
  }
}

// One "closed" status across both screens. Closing a lead (from the GMDSS card or from the mail screen) moves
// the main-CRM lead with the same address to LOST (it leaves the mail list, the to-do list and every sequence)
// and closes the GMDSS lead (no reminders, no mass sends). Both stay in the leads lists.
async function closeEverywhere(prisma, emails, { closed = true, reason = null } = {}) {
  const addrs = [...new Set((emails || []).flatMap((e) => parseEmails(e)))];
  if (!addrs.length) return { main: 0, gmdss: 0 };
  const now = new Date();
  const main = await prisma.lead.findMany({ where: { email: { in: addrs, mode: 'insensitive' } } });
  for (const l of main) {
    if (closed) {
      if (l.stage !== 'LOST') await prisma.activity.create({ data: { leadId: l.id, type: 'STAGE_CHANGED', data: { from: l.stage, to: 'LOST', reason: reason || 'closed' } } });
      await prisma.lead.update({ where: { id: l.id }, data: { stage: 'LOST', nextAction: null, nextFollowUpAt: null } });
      await prisma.enrollment.updateMany({ where: { leadId: l.id, status: 'ACTIVE' }, data: { status: 'STOPPED', stopReason: 'closed', nextRunAt: null } });
      await prisma.emailMessage.updateMany({ where: { leadId: l.id, status: { in: ['QUEUED', 'DRAFT'] } }, data: { status: 'CANCELLED', lastError: 'closed' } });
    } else if (l.stage === 'LOST') {
      await prisma.activity.create({ data: { leadId: l.id, type: 'STAGE_CHANGED', data: { from: 'LOST', to: 'CONTACTED', reason: 'reopened' } } });
      await prisma.lead.update({ where: { id: l.id }, data: { stage: 'CONTACTED' } });
    }
  }
  const gl = (await prisma.gmdssLead.findMany({ where: { email: { not: null } }, select: { id: true, email: true, closedAt: true, closedReason: true } }))
    .filter((l) => parseEmails(l.email).some((e) => addrs.includes(e)));
  for (const l of gl) {
    if (closed && !l.closedAt) {
      await prisma.gmdssLead.update({ where: { id: l.id }, data: { closedAt: now, closedReason: reason || null, followUpAt: null } });
      await logActivity(prisma, l.id, 'closed', `הליד נסגר${reason ? `: ${reason}` : ''}. תזכורות ושליחות הופסקו.`);
    } else if (!closed && l.closedAt) {
      await prisma.gmdssLead.update({ where: { id: l.id }, data: { closedAt: null, closedReason: null } });
      await logActivity(prisma, l.id, 'reopened', 'הליד נפתח מחדש.');
    }
  }
  return { main: main.length, gmdss: gl.length };
}

async function handleGmdssEvent(prisma, event, now = new Date()) {
  const d = event.data || {};
  if (!d.email_id) return false;
  const l = await prisma.gmdssLead.findUnique({ where: { providerId: d.email_id } });
  if (!l) return false;
  const data = {};
  if (event.type === 'email.delivered') data.deliveredAt = l.deliveredAt || now;
  else if (event.type === 'email.opened') { data.openedAt = l.openedAt || now; data.openCount = { increment: 1 }; }
  else if (event.type === 'email.clicked') {
    data.clickedAt = l.clickedAt || now; data.clickCount = { increment: 1 };
    if (d.click && d.click.link) data.lastClickLink = String(d.click.link).slice(0, 500);
  } else if (event.type === 'email.bounced') { data.bouncedAt = now; data.emailStatus = 'bounced'; }
  else return true;
  await prisma.gmdssLead.update({ where: { id: l.id }, data });
  const label = { 'email.delivered': 'delivered', 'email.opened': 'opened', 'email.clicked': 'clicked', 'email.bounced': 'bounced' }[event.type];
  await logActivity(prisma, l.id, label, event.type === 'email.clicked' && d.click ? d.click.link : null, now);
  return true;
}

module.exports = { handleGmdssEvent, logActivity, logReply, findReplyLead, syncReplies, syncSentMail, closeEverywhere, VARIABLES, splitContact, parseCsv, importRows, merge, valuesFor };
