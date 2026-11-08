// Small key/value settings stored in Postgres (editable from the dashboard).
const prisma = require('../db');

const DEFAULT_SIGNATURE = `<table cellpadding="0" cellspacing="0" style="font-family:Arial,sans-serif;font-size:13px;line-height:1.5;color:#333"><tr>
<td style="padding-inline-end:12px;vertical-align:top"><img src="https://www.alargov.com/assets/alex.jpg" width="72" height="72" alt="Alex Argov" style="border-radius:50%;display:block"></td>
<td style="vertical-align:top"><b>Alex Argov</b><br>Skipper &amp; Maritime Instructor | Software Developer<br>
<a href="mailto:alex@alargov.com" style="color:#1f6f54">alex@alargov.com</a> | <a href="https://www.alargov.com" style="color:#1f6f54">www.alargov.com</a><br>
Tel / WhatsApp: +972 52 368 2486</td></tr></table>`;

const DEFAULTS = {
  signatureHtml: DEFAULT_SIGNATURE,
  requireApproval: 'true', // sequence emails wait in the outbox until approved
};

async function getAll(db = prisma) {
  const rows = await db.setting.findMany();
  const map = { ...DEFAULTS };
  rows.forEach((r) => { map[r.key] = r.value; });
  return { signatureHtml: map.signatureHtml, requireApproval: map.requireApproval !== 'false' };
}

async function set(key, value, db = prisma) {
  if (!(key in DEFAULTS)) throw Object.assign(new Error('unknown_setting'), { status: 400 });
  const v = String(value);
  await db.setting.upsert({ where: { key }, create: { key, value: v }, update: { value: v } });
}

module.exports = { getAll, set, DEFAULTS };
