// Progress toward closing, in %. It replaces the stage and priority labels in the UI.
// 0% means stuck: follow-up overdue, nothing sent, or mail sent but never opened.
const prisma = require('../db');

const STAGE_PCT = { NEW: 5, CONTACTED: 15, ENGAGED: 40, QUALIFIED: 60, PROPOSAL: 80 };
const jerDay = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });

async function withProgress(rows) {
  const ids = rows.map((r) => r.id);
  if (!ids.length) return rows;
  const [msgs, ext] = await Promise.all([
    prisma.emailMessage.findMany({ where: { leadId: { in: ids }, status: 'SENT' }, select: { leadId: true, openedAt: true, clickedAt: true } }),
    prisma.activity.findMany({ where: { leadId: { in: ids }, type: { in: ['MANUAL_EMAIL_OUT', 'EMAIL_SENT'] } }, select: { leadId: true }, distinct: ['leadId'] }),
  ]);
  const tracked = new Map(), extSent = new Set(ext.map((a) => a.leadId));
  msgs.forEach((m) => { const t = tracked.get(m.leadId) || { n: 0, opened: false }; t.n += 1; if (m.openedAt || m.clickedAt) t.opened = true; tracked.set(m.leadId, t); });
  const today = jerDay(Date.now());
  return rows.map((l) => {
    const t = tracked.get(l.id), sent = !!t || extSent.has(l.id);
    let pct, why = '';
    if (l.stage === 'WON') pct = 100;
    else if (l.stage === 'LOST') pct = null;
    else if (l.nextFollowUpAt && jerDay(l.nextFollowUpAt) < today) { pct = 0; why = 'באיחור'; }
    else if (!sent && !l.replied) { pct = 0; why = 'לא נשלח'; }
    else if (t && !t.opened && !l.replied) { pct = 0; why = 'לא נפתח'; }
    else pct = Math.max(STAGE_PCT[l.stage] || 0, l.replied ? STAGE_PCT.ENGAGED : 0, t && t.opened ? STAGE_PCT.CONTACTED : sent ? 10 : 0);
    return { ...l, progress: { pct, why } };
  });
}
module.exports = { withProgress };
