// Automatic reminders for GMDSS leads that did not answer. The message depends on how far they got:
// clicked (hot), opened without a click (warm), never opened (cold). Off until switched on in the UI.
const prisma = require('../db');
const config = require('../config');
const settings = require('./settings');
const { getProvider } = require('./provider');
const { renderRich, renderPlain, htmlToText } = require('./render');
const { merge, logActivity } = require('./gmdss');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_REMINDERS = 3;
const WAIT_DAYS = { hot: 3, warm: 5, cold: 7 };
const DAILY_CAP = parseInt(process.env.GMDSS_REMINDER_DAILY_CAP || '40', 10);
const SETTING_KEY = 'gmdssReminders';
const DAY = 86400000;

const TEMPLATES = {
  hot: [
    { subject: 'Quick call about GMDSS training for {{Organization}}?', body: 'Hi,\n\nThanks for taking a look at the GMDSS course and simulator overview I sent. I would like to hear how {{Organization}} trains for GMDSS today and show you how the platform could fit.\n\nIf a 15 minute call works, reply with a time that suits you. If you would rather explore on your own, reply "code" and I will send you a full access code so you can test the system in depth.\n\nBest regards' },
    { subject: 'Re: GMDSS training for {{Organization}}', body: 'Hi,\n\nFollowing up on my earlier note. Many teams find it easiest to try the platform hands-on before talking. I can send you a personal access code to test the full course and simulator, or we can set up a short call.\n\nWhich would you prefer?\n\nBest regards' },
    { subject: 'Last note from me: GMDSS access for {{Organization}}', body: 'Hi,\n\nThis is my last follow-up. The offer stands: a short call, or a full access code to test the system yourself. Just reply with "code" or "call" and I will take care of the rest.\n\nBest regards' },
  ],
  warm: [
    { subject: 'GMDSS training for {{Organization}}: worth a short call?', body: 'Hi,\n\nI wanted to follow up on my earlier email about GMDSS training. I would be glad to show you the course and simulator in a 15 minute call, or send you a code to try it yourself.\n\nReply "call" or "code" and I will arrange it.\n\nBest regards' },
    { subject: 'Re: GMDSS training for {{Organization}}', body: 'Hi,\n\nIn case my earlier note got buried: the platform covers the full GMDSS syllabus with a realistic simulator, and I can give {{Organization}} free test access so you can judge it properly.\n\nWould a short call or a test code be more useful?\n\nBest regards' },
    { subject: 'Closing the loop: GMDSS for {{Organization}}', body: 'Hi,\n\nI do not want to crowd your inbox, so this is my last follow-up. If GMDSS training is on your radar, reply "call" or "code" and I will respond right away.\n\nBest regards' },
  ],
  cold: [
    { subject: 'Re: GMDSS training for {{Organization}}', body: 'Hi,\n\nI am following up on my earlier email in case it did not reach you. In short: a GMDSS course and simulator that {{Organization}} can use for training, available with free test access.\n\nIf it is relevant, reply and I will send details or a short demo.\n\nBest regards' },
    { subject: 'GMDSS course and simulator: quick question', body: 'Hi,\n\nWho handles GMDSS training at {{Organization}}? If you point me to the right person I will keep it brief. I can also send a test access code so you can see the platform first.\n\nBest regards' },
    { subject: 'Last follow-up: GMDSS for {{Organization}}', body: 'Hi,\n\nThis is my last follow-up. If GMDSS training is not a priority now, no problem. If it is, reply and I will send a demo or a test code.\n\nBest regards' },
  ],
};

const segmentOf = (l) => (l.clickCount > 0 ? 'hot' : l.openCount > 0 ? 'warm' : 'cold');

// Pure: is this lead due for its next reminder at `now`?  Returns { segment, n, dueAt } or null.
function dueInfo(l, now = new Date()) {
  if (!l.email || !EMAIL_RE.test(l.email)) return null;
  if (l.emailStatus !== 'sent' || !l.lastEmailedAt) return null;
  if (l.repliedAt || l.bouncedAt) return null;
  if (l.reminderCount >= MAX_REMINDERS) return null;
  const segment = segmentOf(l);
  const last = Math.max(+new Date(l.lastEmailedAt), l.lastReminderAt ? +new Date(l.lastReminderAt) : 0);
  const dueAt = new Date(last + WAIT_DAYS[segment] * DAY);
  if (dueAt > now) return null;
  return { segment, n: l.reminderCount + 1, dueAt };
}

// Reminders go out Sunday to Thursday, 09:00-16:59 Israel time.
function inSendWindow(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(now);
  const wd = p.find((x) => x.type === 'weekday').value;
  const h = +p.find((x) => x.type === 'hour').value;
  return wd !== 'Fri' && wd !== 'Sat' && h >= 9 && h < 17;
}

async function isEnabled() {
  const r = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  return !!r && r.value === 'on';
}
async function setEnabled(on) {
  const value = on ? 'on' : 'off';
  await prisma.setting.upsert({ where: { key: SETTING_KEY }, create: { key: SETTING_KEY, value }, update: { value } });
}

// Saved wording overrides the defaults per segment and step; anything not saved falls back to the default.
const TPL_KEY = 'gmdssReminderTemplates';
const SEGMENTS = ['hot', 'warm', 'cold'];
async function getTemplates() {
  const r = await prisma.setting.findUnique({ where: { key: TPL_KEY } });
  let saved = {};
  try { saved = r ? JSON.parse(r.value) : {}; } catch { saved = {}; }
  const out = {};
  for (const s of SEGMENTS) {
    out[s] = TEMPLATES[s].map((d, i) => {
      const o = saved[s] && saved[s][i];
      return o && String(o.subject || '').trim() && String(o.body || '').trim() ? { subject: String(o.subject).trim(), body: String(o.body).trim() } : d;
    });
  }
  return out;
}
async function saveTemplates(input) {
  const out = {};
  for (const s of SEGMENTS) {
    const arr = input && input[s];
    if (!Array.isArray(arr) || arr.length !== MAX_REMINDERS) throw Object.assign(new Error('templates_incomplete'), { status: 400 });
    out[s] = arr.map((t) => {
      const subject = String((t && t.subject) || '').trim(); const body = String((t && t.body) || '').trim();
      if (!subject || !body) throw Object.assign(new Error('subject_and_body_required'), { status: 400 });
      return { subject, body };
    });
  }
  await prisma.setting.upsert({ where: { key: TPL_KEY }, create: { key: TPL_KEY, value: JSON.stringify(out) }, update: { value: JSON.stringify(out) } });
  return getTemplates();
}
async function resetTemplates() { await prisma.setting.deleteMany({ where: { key: TPL_KEY } }); return getTemplates(); }

function compose(l, segment, n, sig, tpls) {
  const t = (tpls || TEMPLATES)[segment][n - 1];
  const subject = merge(t.subject, l).text;
  const body = merge(t.body, l).text;
  const html = `<div dir="ltr" style="text-align:left;font-family:Arial,sans-serif;font-size:15px;line-height:1.6">${renderRich(body)}${sig ? `<div style="margin-top:20px">${sig}</div>` : ''}`
    + '<p style="font-size:12px;color:#888;margin-top:24px">Not interested? Reply "unsubscribe" and we will not contact you again.</p></div>';
  const text = `${renderPlain(body)}${sig ? `\n\n${htmlToText(sig)}` : ''}\n\n--\nNot interested? Reply "unsubscribe".`;
  return { subject, html, text };
}

async function dueLeads(now = new Date()) {
  const rows = await prisma.gmdssLead.findMany({
    where: { emailStatus: 'sent', repliedAt: null, bouncedAt: null, reminderCount: { lt: MAX_REMINDERS }, email: { not: null } },
    orderBy: { lastEmailedAt: 'asc' },
  });
  return rows.map((l) => ({ l, d: dueInfo(l, now) })).filter((x) => x.d);
}

// Sends one reminder. `force` skips the waiting period (manual button). Returns { sent } | { skipped } | { failed }.
async function sendReminder(id, { force = false, now = new Date() } = {}) {
  const l = await prisma.gmdssLead.findUnique({ where: { id } });
  if (!l) throw Object.assign(new Error('not_found'), { status: 404 });
  const d = dueInfo(l, force ? new Date(8.64e15) : now);
  if (!d) {
    if (!force) return { skipped: 'not_due' };
    if (!l.email || !EMAIL_RE.test(l.email)) throw Object.assign(new Error('lead_has_no_email'), { status: 400 });
    if (l.repliedAt) throw Object.assign(new Error('lead_already_replied'), { status: 409 });
    if (l.reminderCount >= MAX_REMINDERS) throw Object.assign(new Error('max_reminders_reached'), { status: 409 });
    throw Object.assign(new Error('lead_not_mailed_yet'), { status: 409 });
  }
  // Claim: only one caller can move reminderCount from n-1 to n.
  const claim = await prisma.gmdssLead.updateMany({ where: { id, reminderCount: l.reminderCount, repliedAt: null }, data: { reminderCount: { increment: 1 }, lastReminderAt: now } });
  if (!claim.count) return { skipped: 'claimed' };
  const sig = (await settings.getAll()).signatureHtml || '';
  const m = compose(l, d.segment, d.n, sig, await getTemplates());
  try {
    const { providerId } = await getProvider().send({ to: l.email, subject: m.subject, html: m.html, text: m.text, idempotencyKey: `gmdss-rem:${id}:${d.n}` });
    // New provider id so opens/clicks of the reminder land on this lead; counters stay cumulative.
    await prisma.gmdssLead.update({ where: { id }, data: { providerId, followUpAt: new Date(+now + 7 * DAY) } });
    await logActivity(prisma, id, 'reminder', `#${d.n} (${d.segment}) ${m.subject}`);
    return { sent: true, segment: d.segment, n: d.n };
  } catch (e) {
    // Give the reminder back; lastReminderAt stays, so the retry waits a full period instead of looping every minute.
    await prisma.gmdssLead.update({ where: { id }, data: { reminderCount: l.reminderCount, lastError: String(e.message).slice(0, 300) } });
    await logActivity(prisma, id, 'failed', `reminder: ${String(e.message).slice(0, 300)}`);
    return { failed: true, error: e.message };
  }
}

async function sentToday(now) {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  return prisma.gmdssActivity.count({ where: { type: 'reminder', createdAt: { gte: start } } });
}

// Scheduler entry point (every minute): at most `sendsPerMinute` per tick, `DAILY_CAP` per day.
async function runDue(now = new Date(), { ignoreWindow = false } = {}) {
  if (!ignoreWindow && (!(await isEnabled()) || !inSendWindow(now))) return { sent: 0, skipped: 'off_or_outside_window' };
  const room = Math.max(0, DAILY_CAP - (await sentToday(now)));
  const batch = (await dueLeads(now)).slice(0, Math.min(room, Math.max(1, config.sendsPerMinute)));
  let sent = 0; let failed = 0;
  for (const { l } of batch) {
    const r = await sendReminder(l.id, { now });
    if (r.sent) sent += 1; else if (r.failed) failed += 1;
  }
  return { sent, failed, due: batch.length };
}

// Manual access-code email from the customer card. The code is generated unless the caller supplies one.
function newCode() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i += 1) s += a[Math.floor(Math.random() * a.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
async function sendCode(id, { code, note } = {}) {
  const l = await prisma.gmdssLead.findUnique({ where: { id } });
  if (!l) throw Object.assign(new Error('not_found'), { status: 404 });
  if (!l.email || !EMAIL_RE.test(l.email)) throw Object.assign(new Error('lead_has_no_email'), { status: 400 });
  const c = String(code || '').trim() || newCode();
  const sig = (await settings.getAll()).signatureHtml || '';
  const extra = String(note || '').trim();
  const body = `Hi,\n\nThank you for your interest. Here is your personal access code to test the GMDSS course and simulator in depth:\n\n${c}\n${extra ? `\n${extra}\n` : ''}\nTake your time exploring, and reply with any questions or feedback. I am also happy to walk you through it on a short call.\n\nBest regards`;
  const subject = `Your GMDSS access code for ${l.organization}`;
  const html = `<div dir="ltr" style="text-align:left;font-family:Arial,sans-serif;font-size:15px;line-height:1.6">${renderRich(body)}${sig ? `<div style="margin-top:20px">${sig}</div>` : ''}</div>`;
  const text = `${renderPlain(body)}${sig ? `\n\n${htmlToText(sig)}` : ''}`;
  const { providerId } = await getProvider().send({ to: l.email, subject, html, text, idempotencyKey: `gmdss-code:${id}:${Date.now()}` });
  const now = new Date();
  await prisma.gmdssLead.update({ where: { id }, data: { accessCode: c, codeSentAt: now, providerId, followUpAt: new Date(+now + 7 * DAY) } });
  await logActivity(prisma, id, 'code_sent', `Access code ${c} sent`);
  return { code: c, sentTo: l.email };
}

module.exports = { dueInfo, segmentOf, inSendWindow, isEnabled, setEnabled, dueLeads, sendReminder, runDue, sendCode, newCode, getTemplates, saveTemplates, resetTemplates, TEMPLATES, WAIT_DAYS, MAX_REMINDERS, DAILY_CAP };
