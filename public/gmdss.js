/* GMDSS Outreach Leads page. Vanilla JS, same conventions as app.js. */
let csrf = '';
let leads = [];
let templates = [];
let variables = [];
let emailConfigured = true;
let sortKey = 'priority', sortDir = 1;
const selected = new Set();
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COLS = [
  ['organization', 'ארגון'], ['country', 'מדינה'], ['segment', 'סוג'], ['progress', 'התקדמות'],
  ['email', 'קשר'], ['emailStatus', 'סטטוס'], ['engagement', 'נמסר · נפתח · הקלקה'], ['lastEmailedAt', 'נשלח לאחרונה'], ['followUpAt', 'מעקב'],
];
// Interface labels are Hebrew; lead data and everything that goes into an email stay as written.
const STATUS = { not_sent: 'לא נשלח', queued: 'בתור', sent: 'נשלח', failed: 'נכשל', bounced: 'חזר' };
const FIT = { Course: 'קורס', Simulator: 'סימולטור', Both: 'שניהם' };
const dayHe = (d) => new Date(d).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: '2-digit' });
const isDue = (l) => !!(!l.closedAt && l.followUpAt &&new Date(l.followUpAt) <= new Date());
// Progress toward closing, in %: 0% = follow-up overdue, not sent, or sent but never opened (same idea as the main CRM).
const progMatch = (pct, f) => !f || (pct != null && (f === 'z' ? pct === 0 : f === 'lo' ? pct > 0 && pct < 40 : f === 'mid' ? pct >= 40 && pct < 80 : pct >= 80));
function gmProg(l) {
  if (l.closedAt) return { pct: null, why: '' };
  if (isDue(l)) return { pct: 0, why: 'באיחור' };
  if (l.emailStatus === 'not_sent') return { pct: 0, why: 'לא נשלח' };
  if (['failed', 'bounced'].includes(l.emailStatus)) return { pct: 0, why: 'נכשל' };
  if (l.emailStatus === 'sent' && !l.openedAt && !l.clickedAt && !l.repliedAt) return { pct: 0, why: 'לא נפתח' };
  return { pct: l.accessCode ? 60 : l.answeredAt ? 50 : l.repliedAt ? 40 : l.clickedAt ? 25 : l.openedAt ? 15 : 10, why: '' };
}
const progCell = (l) => {
  const p = gmProg(l);
  if (p.pct === null) return '<span class="prog closed"><b>סגור</b></span>';
  return `<span class="prog ${p.pct === 0 ? 'zero' : p.pct >= 60 ? 'hi' : ''}"><i style="width:${p.pct}%"></i><b>${p.pct}%</b>${p.why ? `<em>${p.why}</em>` : ''}</span>`;
};
// Email-status filter. The summary chips above the table use the same predicates.
const ENG = {
  sent: (l) => l.emailStatus === 'sent',
  notsent: (l) => l.emailStatus === 'not_sent' && !l.closedAt,
  opened: (l) => !!l.openedAt,
  clicked: (l) => !!l.clickedAt,
  unopened: (l) => l.emailStatus === 'sent' && !l.openedAt,
  failed: (l) => ['failed', 'bounced'].includes(l.emailStatus),
  replied: (l) => !!l.repliedAt && !l.closedAt, // closed leads are out of every round
  answered: (l) => !!l.answeredAt && !l.closedAt,
  reminded: (l) => (l.reminderCount || 0) > 0,
  manualRem: (l) => !!l.manualReminderAt,
  followup: isDue,
  closed: (l) => !!l.closedAt,
  open: (l) => !l.closedAt,
};
const CHIPS = [['', 'כל הלידים'], ['sent', 'נשלחו'], ['notsent', 'לא נשלחו'], ['opened', 'נפתחו'], ['clicked', 'הקליקו'], ['replied', 'השיבו'], ['answered', 'נענו'], ['reminded', 'קיבלו תזכורת'], ['manualRem', 'תזכורת ידנית'], ['followup', 'מעקב להיום'], ['closed', 'ארכיון']];
const MORE_FILTERS = ['#f-country', '#f-segment', '#f-fit', '#f-prog', '#f-template'];
const LTR = new Set();
const TEXT = ['organization', 'contactName', 'country', 'segment', 'productFit', 'whyTheydBuy', 'website', 'email', 'phone', 'priority', 'emailStatus'];
const fmt = (d) => (d ? new Date(d).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : '');
const engScore = (l) => (l.clickedAt ? 3 : l.openedAt ? 2 : l.deliveredAt ? 1 : 0);

async function api(path, opts = {}) {
  const r = await fetch(`/api/gmdss${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (r.status === 401) { location.href = '/login'; throw new Error('unauthenticated'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.message || data.error || `HTTP ${r.status}`), { data });
  return data;
}
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = `toast show${err ? ' err' : ''}`;
  clearTimeout(t._t); t._t = setTimeout(() => { t.className = 'toast'; }, 3500);
}

function filtered() {
  const q = $('#q').value.trim().toLowerCase();
  const f = { country: $('#f-country').value, segment: $('#f-segment').value, productFit: $('#f-fit').value };
  const pf = $('#f-prog').value;
  const tpl = $('#f-template').value, eng = $('#f-eng').value;
  const rows = leads.filter((l) => {
    for (const k in f) if (f[k] && l[k] !== f[k]) return false;
    if (pf && !progMatch(gmProg(l).pct, pf)) return false;
    if (tpl === 'none' && l.templateId) return false;
    if (tpl && tpl !== 'none' && String(l.templateId) !== tpl) return false;
    if (eng !== 'closed' && l.closedAt) return false; // closed leads live in the archive chip only
    if (eng && !ENG[eng](l)) return false;
    return !q || TEXT.some((k) => (l[k] || '').toLowerCase().includes(q));
  });
  const val = (l) => (sortKey === 'engagement' ? engScore(l) : sortKey === 'progress' ? (gmProg(l).pct ?? -1) : l[sortKey]);
  return rows.sort((a, b) => {
    const x = val(a) ?? '', y = val(b) ?? '';
    if (x === y) return 0;
    if (x === '') return 1;
    if (y === '') return -1; // empty values always last
    return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y), 'en', { numeric: true })) * sortDir;
  });
}

function engagement(l) {
  const pill = (on, ico, label, title) => `<span class="eg ${on ? 'on' : ''}" title="${esc(title)}">${ico} ${label}</span>`;
  return `<span class="egs">${pill(l.deliveredAt, '✓', 'נמסר', l.deliveredAt ? `נמסר ${fmt(l.deliveredAt)}` : 'עוד לא נמסר')}`
    + `${pill(l.openedAt, '👁', l.openCount > 1 ? `נפתח ${l.openCount}x` : 'נפתח', l.openedAt ? `נפתח לאחרונה ${fmt(l.lastOpenedAt || l.openedAt)} · פעם ראשונה ${fmt(l.openedAt)} (${l.openCount}x)` : 'לא נפתח')}`
    + `${pill(l.clickedAt, '↗', l.clickCount > 1 ? `הקלקה ${l.clickCount}x` : 'הקלקה', l.clickedAt ? `הקלקה אחרונה ${fmt(l.lastClickedAt || l.clickedAt)} · ראשונה ${fmt(l.clickedAt)} (${l.clickCount}x) ${l.lastClickLink || ''}` : 'אין הקלקה על קישור')}</span>`
    + (l.openedAt || l.clickedAt ? `<div class="why" style="white-space:nowrap">${l.openedAt ? `👁 ${esc(fmt(l.lastOpenedAt || l.openedAt))}` : ''}${l.openedAt && l.clickedAt ? ' · ' : ''}${l.clickedAt ? `↗ ${esc(fmt(l.lastClickedAt || l.clickedAt))}` : ''}</div>` : '');
}

function contact(l) {
  const out = [];
  if (l.email) out.push(`<a href="mailto:${esc(l.email)}">${esc(l.email)}</a>`);
  if (l.phone) out.push(`<a href="tel:${esc(l.phone.replace(/[^\d+]/g, ''))}">${esc(l.phone)}</a>`);
  if (l.website) out.push(`<a href="${esc(l.website)}" target="_blank" rel="noopener noreferrer">${esc(l.website.replace(/^https?:\/\/(www\.)?/, ''))}</a>`);
  return out.length ? `<div class="ct">${out.join('')}</div>` : '<span class="muted-cell">—</span>';
}

function cell(l, k) {
  const v = l[k];
  if (k === 'email') return contact(l);
  if (k === 'progress') return progCell(l);
  if (k === 'engagement') return l.emailStatus === 'not_sent' ? '<span class="muted-cell">—</span>' : engagement(l);
  if (k === 'template') return l.template ? `<span class="st">${esc(l.template.name)}</span>` : '<span class="muted-cell">—</span>';
  if (v == null || v === '') return '<span class="muted-cell">—</span>';
  if (k === 'organization') return `<div class="org"><button class="btn sm ed" data-edit="${l.id}" title="ערוך ליד">✎</button><a href="#" data-card="${l.id}">${esc(v)}</a>${l.hasDraft ? '<span class="st queued" title="יש טיוטה שמורה בכרטיס">📝 טיוטה</span>' : ''}</div>${l.contactName ? `<div class="why" dir="ltr" style="text-align:start">👤 ${esc(l.contactName)}</div>` : ''}${l.whyTheydBuy ? `<div class="why" title="${esc(l.whyTheydBuy)}">${esc(l.whyTheydBuy)}</div>` : ''}`;
  if (k === 'followUpAt') { const due = isDue(l); return `<span class="st ${due ? 'failed' : ''}" title="${due ? 'הגיע מועד המעקב' : 'מעקב מתוכנן'}">${esc(dayHe(v))}</span>`; }
  if (k === 'productFit') return esc(FIT[v] || v);
  if (k === 'priority') return `<span class="pb ${esc(v)}">${esc(v)}</span>`;
  if (k === 'website') return `<a href="${esc(v)}" target="_blank" rel="noopener noreferrer">${esc(v.replace(/^https?:\/\/(www\.)?/, ''))}</a>`;
  if (k === 'email') return `<a href="mailto:${esc(v)}">${esc(v)}</a>`;
  if (k === 'phone') return `<a href="tel:${esc(v.replace(/[^\d+]/g, ''))}">${esc(v)}</a>`;
  if (k === 'emailStatus') {
    const tag = (cls, txt, title) => ` <span class="st ${cls}" title="${esc(title)}">${txt}</span>`;
    return `<a href="#" class="stlink" data-card="${l.id}" title="פתיחת כרטיס הליד"><span class="st ${esc(v)}" ${l.lastError ? `title="${esc(l.lastError)}"` : ''}>${esc(STATUS[v] || v)}</span>`
      + `${l.reminderCount ? tag('', `🔔 תזכורת ${l.reminderCount}${l.manualReminderAt ? ' ידנית' : ''}`, `תזכורות שנשלחו: ${l.reminderCount}${l.lastReminderAt ? ` (אחרונה ${fmt(l.lastReminderAt)})` : ''}`) : ''}`
      + `${l.closedAt ? tag('failed', '⛔ סגור', `נסגר ${fmt(l.closedAt)}${l.closedReason ? `: ${l.closedReason}` : ''}. אין תזכורות ושליחות.`) : ''}`
      + `${l.answeredAt ? tag('sent', 'נענה ✓', `שלחנו לו תשובה ${fmt(l.answeredAt)}`) : ''}`
      + `${l.repliedAt ? tag('sent', '↩ השיב', `השיב ${fmt(l.repliedAt)}`) : ''}</a>`;
  }
  if (k === 'lastEmailedAt') return esc(fmt(v));
  return esc(v);
}

function render() {
  const rows = filtered();
  $('#tbl thead').innerHTML = `<tr><th><input type="checkbox" id="chk-page" title="בחר את המוצגים"></th>${COLS.map(([k, h]) =>
    `<th data-k="${k}" title="${k === 'engagement' ? 'נמסר = המייל הגיע לתיבה. נפתח = הנמען פתח אותו. הקלקה = לחץ על קישור או סרטון' : ''}">${h}${sortKey === k ? (sortDir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr>`;
  $('#tbl tbody').innerHTML = rows.map((l) => `<tr class="p-${esc(l.priority || '')}${l.dormant ? ' dormant' : ''}"${l.dormant ? ' title="ליד רדום: אין פעילות מעל 14 יום"' : ''}>
    <td><input type="checkbox" class="rc" data-id="${l.id}" ${selected.has(l.id) ? 'checked' : ''} ${l.email ? '' : 'title="אין אימייל: אפשר למחוק או לערוך, אי אפשר לשלוח"'}></td>
    ${COLS.map(([k]) => `<td>${cell(l, k)}</td>`).join('')}</tr>`).join('')
    || `<tr><td colspan="${COLS.length + 1}" class="muted">אין תוצאות</td></tr>`;
  $('#count').textContent = rows.length === leads.length ? leads.length : `${rows.length} מתוך ${leads.length}`;
  const pick = rows.filter((l) => l.email);
  $('#chk-page').checked = pick.length > 0 && pick.every((l) => selected.has(l.id));
  const eng = $('#f-eng').value;
  $('#kpis').innerHTML = CHIPS.map(([k, label]) => {
    const n = k ? leads.filter(ENG[k]).length : leads.filter((l) => !l.closedAt).length;
    return `<button type="button" class="k ${eng === k ? 'on' : ''} ${k === 'followup' && n ? 'red' : ''}" data-eng="${k}" aria-pressed="${eng === k}"><b>${n}</b><span>${label}</span></button>`;
  }).join('');
  updateBar();
}

// Toolbar state: how many folded filters are on, and the bulk bar for selected leads.
function updateBar() {
  const on = MORE_FILTERS.filter((s) => $(s).value).length;
  $('#f-count').textContent = on;
  $('#f-count').classList.toggle('hidden', !on);
  $('#reset').classList.toggle('hidden', !on && !$('#q').value && !$('#f-eng').value);
  $('#sel-n').textContent = `${selected.size} מסומנים`;
  $('#bulk-bar').classList.toggle('hidden', !selected.size);
}

function fillFilters() {
  const opts = (k) => [...new Set(leads.map((l) => l[k]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  for (const [id, k, label] of [['#f-country', 'country', 'כל המדינות'], ['#f-segment', 'segment', 'כל הסוגים']]) {
    const cur = $(id).value;
    $(id).innerHTML = `<option value="">${label}</option>` + opts(k).map((o) => `<option>${esc(o)}</option>`).join('');
    $(id).value = cur;
  }
  const cur = $('#f-template').value;
  $('#f-template').innerHTML = '<option value="">כל התבניות</option><option value="none">בלי תבנית</option>'
    + templates.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  $('#f-template').value = cur;
}

async function load() {
  [leads, templates] = await Promise.all([api('/leads'), api('/templates')]);
  fillFilters();
  for (const id of [...selected]) { const l = leads.find((x) => x.id === id); if (!l) selected.delete(id); }
  render();
}

// ---------- Dialog helpers ----------
const dlgOpen = (html) => { $('#dlg-box').innerHTML = html; $('#dlg').classList.remove('hidden'); };
const dlgClose = () => { $('#dlg').classList.add('hidden'); };
const tplOptions = (sel) => templates.map((t) => `<option value="${t.id}" ${t.id === sel ? 'selected' : ''}>${esc(t.name)}</option>`).join('');

function insertAt(field, text) {
  const s = field.selectionStart ?? field.value.length, e = field.selectionEnd ?? s;
  field.value = field.value.slice(0, s) + text + field.value.slice(e);
  field.focus(); field.setSelectionRange(s + text.length, s + text.length);
  field.dispatchEvent(new Event('input'));
}

// ---------- Manual compose tools: load a template, variables, YouTube, link, live preview (same as the template editor) ----------
function toolsHtml(px) {
  return `<div class="vars">
      <select id="${px}-tpl" aria-label="טעינת תבנית"><option value="">טעינת תבנית...</option>${templates.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>
      <button type="button" class="btn sm" id="${px}-yt">▶ סרטון YouTube</button>
      <button type="button" class="btn sm" id="${px}-link">🔗 קישור</button>
      ${variables.map((v) => `<button type="button" class="btn sm" data-pv="${px}" data-v="${esc(v)}">{{${esc(v)}}}</button>`).join('')}
    </div>
    <details id="${px}-pv"><summary class="muted" style="cursor:pointer">תצוגה מקדימה עם נתוני הליד</summary>
      <div class="prev"><div><b>נושא:</b> <span id="${px}-psub" dir="ltr"></span></div><hr><div id="${px}-pbody" dir="ltr"></div></div></details>
    <div id="${px}-pwarn" class="warn"></div>`;
}
function wireTools(px, subSel, bodySel, leadId, { footer = false } = {}) {
  const sub = $(subSel), body = $(bodySel);
  let last = body, timer;
  sub.addEventListener('focus', () => { last = sub; });
  body.addEventListener('focus', () => { last = body; });
  const preview = async () => {
    try {
      const p = await api('/preview', { method: 'POST', body: { subject: sub.value, body: body.value, leadId, footer } });
      $(`#${px}-psub`).textContent = p.subject; $(`#${px}-pbody`).innerHTML = p.html;
      $(`#${px}-pwarn`).textContent = p.unknown.length ? `משתנים לא מוכרים: ${p.unknown.map((u) => `{{${u}}}`).join(', ')}` : '';
    } catch (e) { $(`#${px}-pwarn`).textContent = e.message; }
  };
  const refresh = () => { clearTimeout(timer); timer = setTimeout(preview, 300); };
  sub.addEventListener('input', refresh); body.addEventListener('input', refresh);
  document.querySelectorAll(`#dlg-box [data-pv="${px}"]`).forEach((b) => {
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = () => { insertAt(last, `{{${b.dataset.v}}}`); refresh(); };
  });
  $(`#${px}-tpl`).onchange = (e) => {
    const t = templates.find((x) => x.id === +e.target.value);
    e.target.value = '';
    if (!t) return;
    if (body.value.trim() && !confirm('להחליף את הנושא והתוכן בתבנית?')) return;
    sub.value = t.subject; body.value = t.body; body.dispatchEvent(new Event('input'));
  };
  $(`#${px}-yt`).onclick = () => {
    const u = prompt('קישור YouTube (https://youtu.be/... או https://www.youtube.com/watch?v=...)');
    if (!u) return;
    if (!/^https?:\/\/(www\.)?(youtu\.be\/|youtube\.com\/)/i.test(u.trim())) { toast('לא קישור YouTube תקין', true); return; }
    insertAt(body, `\n[video:${u.trim()}]\n`); refresh();
  };
  $(`#${px}-link`).onclick = () => {
    const u = prompt('כתובת הקישור (https://...)');
    if (!u || !/^https?:\/\//i.test(u.trim())) return;
    const t = prompt('טקסט הקישור', 'Learn more') || u;
    insertAt(body, `[${t}](${u.trim()})`); refresh();
  };
  $(`#${px}-pv`).addEventListener('toggle', preview);
  return refresh;
}

// ---------- Template manager ----------
const DEFAULT_SUBJECT = 'GMDSS training tools for {{Organization}}';
const DEFAULT_BODY = `Hello,

I am reaching out to {{Organization}} ({{Country}}). {{Why They'd Buy}}

I built a GMDSS exam-prep course and simulator and think it could fit your {{Segment}} work. Short demo:

[video:https://www.youtube.com/watch?v=VIDEO_ID]

More details: {{Website}}

Best regards,
Alex`;

async function openTemplates(selId) {
  try { templates = await api('/templates'); } catch (e) { /* keep cached list */ } // never edit a stale copy
  let cur = templates.find((t) => t.id === selId) || templates[0] || null; // open on a saved template, not a blank form
  const draw = () => {
    dlgOpen(`<h3 style="margin-top:0">תבניות מייל</h3>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
        ${templates.map((t) => `<button class="btn sm ${cur && cur.id === t.id ? 'primary' : ''}" data-tid="${t.id}">${esc(t.name)}</button>`).join('')}
        <button class="btn sm ${cur ? '' : 'primary'}" data-tid="new">+ תבנית חדשה</button>
      </div>
      <label>שם התבנית<input id="m-name" style="width:100%" value="${esc(cur ? cur.name : '')}" placeholder="למשל: Intro + YouTube demo"></label>
      <label>נושא<input id="m-sub" dir="ltr" style="width:100%" value="${esc(cur ? cur.subject : DEFAULT_SUBJECT)}"></label>
      <label>תוכן<textarea id="m-body" dir="ltr" rows="11">${esc(cur ? cur.body : DEFAULT_BODY)}</textarea></label>
      <div class="vars">
        <button type="button" class="btn sm" id="m-yt">▶ הוספת סרטון YouTube</button>
        <button type="button" class="btn sm" id="m-link">🔗 הוספת קישור</button>
        ${variables.map((v) => `<button type="button" class="btn sm" data-v="${esc(v)}">{{${esc(v)}}}</button>`).join('')}
      </div>
      <div class="muted">YouTube נכנס כתמונה ממוזערת שלחיצה עליה פותחת את הסרטון. הקלקה נספרת בעמודת "הקלקה".</div>
      <div class="prev"><div><b>נושא:</b> <span id="p-sub" dir="ltr"></span></div><hr><div id="p-body" dir="ltr"></div><div id="p-warn" class="warn"></div></div>
      <div style="display:flex;gap:8px;margin-top:12px;align-items:center">
        ${cur ? '<button class="btn danger" id="m-del">מחיקה</button>' : ''}
        <span style="flex:1"></span>
        <button class="btn ghost" id="m-close">סגירה</button>
        <button class="btn primary" id="m-save">שמירה</button>
      </div>`);
    let last = $('#m-body');
    $('#m-sub').onfocus = () => { last = $('#m-sub'); };
    $('#m-body').onfocus = () => { last = $('#m-body'); };
    let timer;
    const preview = async () => {
      try {
        const p = await api('/preview', { method: 'POST', body: { subject: $('#m-sub').value, body: $('#m-body').value } });
        $('#p-sub').textContent = p.subject; $('#p-body').innerHTML = p.html;
        $('#p-warn').textContent = p.unknown.length ? `משתנים לא מוכרים: ${p.unknown.map((u) => `{{${u}}}`).join(', ')}` : '';
      } catch (e) { $('#p-warn').textContent = e.message; }
    };
    const refresh = () => { clearTimeout(timer); timer = setTimeout(preview, 250); };
    $('#m-sub').oninput = refresh; $('#m-body').oninput = refresh;
    document.querySelectorAll('#dlg-box [data-v]').forEach((b) => {
      b.onmousedown = (e) => e.preventDefault();
      b.onclick = () => { insertAt(last, `{{${b.dataset.v}}}`); refresh(); };
    });
    $('#m-yt').onclick = () => {
      const u = prompt('קישור YouTube (https://youtu.be/... או https://www.youtube.com/watch?v=...)');
      if (!u) return;
      if (!/^https?:\/\/(www\.)?(youtu\.be\/|youtube\.com\/)/i.test(u.trim())) return toast('לא קישור YouTube תקין', true);
      insertAt($('#m-body'), `\n[video:${u.trim()}]\n`); refresh();
    };
    $('#m-link').onclick = () => {
      const u = prompt('כתובת הקישור (https://...)');
      if (!u || !/^https?:\/\//i.test(u.trim())) return;
      const t = prompt('טקסט הקישור', 'Learn more') || u;
      insertAt($('#m-body'), `[${t}](${u.trim()})`); refresh();
    };
    document.querySelectorAll('#dlg-box [data-tid]').forEach((b) => {
      b.onclick = () => { cur = b.dataset.tid === 'new' ? null : templates.find((t) => t.id === +b.dataset.tid); draw(); };
    });
    $('#m-close').onclick = dlgClose;
    $('#m-save').onclick = async () => {
      const body = { name: $('#m-name').value, subject: $('#m-sub').value, body: $('#m-body').value };
      try {
        const saved = cur ? await api(`/templates/${cur.id}`, { method: 'PUT', body }) : await api('/templates', { method: 'POST', body });
        await load(); cur = templates.find((t) => t.id === saved.id); toast('התבנית נשמרה'); draw();
      } catch (e) { toast(e.message === 'name_subject_body_required' ? 'שם, נושא ותוכן חובה' : e.message, true); }
    };
    if ($('#m-del')) {
      $('#m-del').onclick = async () => {
        if (!confirm(`למחוק את התבנית "${cur.name}"? לידים שמחוברים אליה ינותקו ממנה.`)) return;
        try { await api(`/templates/${cur.id}`, { method: 'DELETE' }); cur = null; await load(); draw(); } catch (e) { toast(e.message, true); }
      };
    }
    preview();
  };
  draw();
}

// ---------- Attach template to selected ----------
function openAttach() {
  if (!templates.length) { toast('צור תבנית קודם', true); openTemplates(); return; }
  dlgOpen(`<h3 style="margin-top:0">שיוך תבנית · ${selected.size} לידים</h3>
    <label>תבנית<select id="a-tpl" style="width:100%"><option value="">בלי תבנית (ניתוק)</option>${tplOptions(0)}</select></label>
    <div style="display:flex;gap:8px;margin-top:12px"><span style="flex:1"></span>
    <button class="btn ghost" id="a-cancel">ביטול</button><button class="btn primary" id="a-ok">שיוך</button></div>`);
  $('#a-cancel').onclick = dlgClose;
  $('#a-ok').onclick = async () => {
    try {
      const r = await api('/assign', { method: 'POST', body: { ids: [...selected], templateId: $('#a-tpl').value || null } });
      toast(`${r.updated} לידים עודכנו`); dlgClose(); await load();
    } catch (e) { toast(e.message, true); }
  };
}

// ---------- Send dialog ----------
function openSend() {
  if (!templates.length) { toast('צור תבנית קודם', true); openTemplates(); return; }
  const ids = [...selected].filter((id) => { const l = leads.find((x) => x.id === id); return l && l.email; });
  if (!ids.length) { toast('לאף ליד מסומן אין מייל', true); return; }
  const first = leads.find((l) => l.id === ids[0]);
  const common = leads.filter((l) => ids.includes(l.id)).map((l) => l.templateId);
  const pre = common.every((t) => t === common[0]) && common[0] ? common[0] : templates[0].id;
  dlgOpen(`<h3 style="margin-top:0">שליחת מייל · ${ids.length} לידים</h3>
    ${emailConfigured ? '' : '<p class="warn">שליחה לא מוגדרת בשרת. תצוגה מקדימה זמינה, שליחה תיכשל עם הודעת הגדרה.</p>'}
    <label>תבנית<select id="s-tpl" style="width:100%">${tplOptions(pre)}</select></label>
    <div class="muted">תצוגה מקדימה ל: <b dir="ltr">${esc(first.organization)}</b></div>
    <div class="prev"><div><b>נושא:</b> <span id="p-sub" dir="ltr"></span></div><hr><div id="p-body" dir="ltr"></div><div id="p-warn" class="warn"></div></div>
    <hr>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <input id="t-to" type="email" dir="ltr" placeholder="כתובת לבדיקה" style="min-width:220px">
      <button class="btn" id="t-test">שליחת בדיקה</button>
      <span style="flex:1"></span>
      <label class="chk"><input type="checkbox" id="t-resend"> כלול גם מי שכבר נשלח</label>
      <button class="btn ghost" id="t-cancel">ביטול</button>
      <button class="btn primary" id="t-send">שלח ל-${ids.length}</button>
    </div>`);
  const tpl = () => templates.find((t) => t.id === +$('#s-tpl').value);
  const preview = async () => {
    const t = tpl();
    try {
      const p = await api('/preview', { method: 'POST', body: { subject: t.subject, body: t.body, leadId: first.id } });
      $('#p-sub').textContent = p.subject; $('#p-body').innerHTML = p.html;
      $('#p-warn').textContent = p.unknown.length ? `משתנים לא מוכרים: ${p.unknown.map((u) => `{{${u}}}`).join(', ')}` : '';
    } catch (e) { $('#p-warn').textContent = e.message; }
  };
  $('#s-tpl').onchange = preview;
  preview();
  $('#t-cancel').onclick = dlgClose;
  $('#t-test').onclick = async () => {
    const t = tpl();
    try {
      const r = await api('/test-email', { method: 'POST', body: { subject: t.subject, body: t.body, leadId: first.id, to: $('#t-to').value } });
      toast(`נשלח בדיקה ל-${r.sentTo}`);
    } catch (e) { toast(e.message === 'invalid_email' ? 'כתובת בדיקה לא תקינה' : e.message, true); }
  };
  $('#t-send').onclick = async () => {
    const includeSent = $('#t-resend').checked;
    const n = ids.filter((id) => { const l = leads.find((x) => x.id === id); return l.email && (includeSent || l.emailStatus !== 'sent'); }).length;
    if (!n) { toast('אין נמענים זכאים', true); return; }
    if (!confirm(`לשלוח ${n} מיילים אמיתיים (מייל נפרד לכל ליד) עם התבנית "${tpl().name}"? הפעולה לא הפיכה.`)) return;
    try {
      const r = await api('/send', { method: 'POST', body: { ids, templateId: tpl().id, includeSent } });
      toast(`בתור: ${r.queued}, דולגו: ${r.skipped}, קצב ${r.perMinute}/דקה`);
      selected.clear(); dlgClose(); poll();
    } catch (e) { toast(e.message, true); }
  };
}

async function poll() {
  await load();
  const { sending } = await api('/send/status');
  if (sending) setTimeout(poll, 4000);
}

// ---------- Wiring ----------
['#q', '#f-country', '#f-segment', '#f-fit', '#f-prog', '#f-template', '#f-eng'].forEach((s) => { $(s).oninput = render; });
$('#reset').onclick = () => { ['#q', '#f-country', '#f-segment', '#f-fit', '#f-prog', '#f-template', '#f-eng'].forEach((s) => { $(s).value = ''; }); render(); };
$('#f-toggle').onclick = () => {
  const open = $('#f-more').classList.toggle('hidden') === false;
  $('#f-toggle').setAttribute('aria-expanded', String(open));
};
$('#kpis').onclick = (e) => { const k = e.target.closest('[data-eng]'); if (k) { $('#f-eng').value = k.dataset.eng; render(); } };
$('#sel-none').onclick = () => { selected.clear(); render(); };
$('#send').onclick = openSend;
$('#bulk-close').onclick = async () => {
  const ids = [...selected];
  if (!ids.length || !confirm(`לסגור ${ids.length} לידים? לא יישלחו אליהם תזכורות או מיילים. אפשר לפתוח מחדש מהכרטיס.`)) return;
  try { const r = await api('/leads/close', { method: 'POST', body: { ids, closed: true } }); selected.clear(); await load(); toast(`${r.updated} לידים נסגרו`); } catch (e) { toast(e.message, true); }
};
$('#bulk-del').onclick = async () => {
  const ids = [...selected];
  if (!ids.length || !confirm(`למחוק לצמיתות ${ids.length} לידים וכל ההיסטוריה שלהם? אי אפשר לשחזר.`)) return;
  try { const r = await api('/leads/delete', { method: 'POST', body: { ids } }); selected.clear(); await load(); toast(`${r.deleted} לידים נמחקו`); } catch (e) { toast(e.message, true); }
};
$('#attach').onclick = openAttach;
$('#tpls').onclick = () => openTemplates();
$('#refresh').onclick = () => load().catch((e) => toast(e.message, true));
$('#imp').onclick = () => $('#imp-file').click();
$('#imp-file').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const r = await api('/import', { method: 'POST', body: { csv: await f.text() } });
    toast(`נקראו ${r.read}, נוספו ${r.inserted}, כפילויות ${r.duplicates}, בלי אימייל ${r.noEmail}, בלי טלפון ${r.noPhone}`);
    await load();
  } catch (err) { toast(err.message, true); }
  e.target.value = '';
};
// ---------- Manual lead from a link ----------
const ADD_FIELDS = [['organization', 'ארגון *'], ['contactName', 'איש קשר'], ['email', 'אימייל'], ['phone', 'טלפון'], ['website', 'אתר'], ['country', 'מדינה'], ['segment', 'סוג'], ['productFit', 'התאמה'], ['priority', 'עדיפות'], ['whyTheydBuy', 'למה יקנו']];
function openAdd(prefill = {}, meta = {}) {
  const inp = ([k, h]) => {
    const v = esc(prefill[k] || '');
    if (k === 'productFit') return `<label>${h}<select id="ad-${k}"><option value=""></option>${['Course', 'Simulator', 'Both'].map((o) => `<option value="${o}"${prefill[k] === o ? ' selected' : ''}>${FIT[o]}</option>`).join('')}</select></label>`;
    if (k === 'priority') return `<label>${h}<select id="ad-${k}"><option value=""></option>${['A', 'B', 'C'].map((o) => `<option${prefill[k] === o ? ' selected' : ''}>${o}</option>`).join('')}</select></label>`;
    if (k === 'whyTheydBuy') return `<label style="grid-column:1/-1">${h}<textarea id="ad-${k}" rows="2" dir="ltr" style="width:100%">${v}</textarea></label>`;
    return `<label>${h}<input id="ad-${k}" value="${v}" dir="ltr" style="width:100%"${k === 'segment' ? ' list="ad-segs"' : ''}></label>`;
  };
  const segs = [...new Set(leads.map((l) => l.segment).filter(Boolean))].sort();
  const others = (meta.emails || []).filter((e) => e.toLowerCase() !== String(prefill.email || '').toLowerCase());
  dlgOpen(`<h3 style="margin-top:0">＋ ליד מקישור</h3>
    <div style="display:flex;gap:6px"><input id="ad-url" type="url" dir="ltr" placeholder="https://..." value="${esc(meta.url || '')}" style="flex:1"><button class="btn primary" id="ad-go">גזור ליד</button></div>
    <div id="ad-msg" class="muted" style="margin:6px 0;min-height:18px">${meta.msg || 'הדבק קישור לאתר, דף קשר או פרופיל. המערכת ממלאת את השדות ואתה מאשר לפני שמירה.'}</div>
    ${meta.duplicate ? `<div class="warn" style="margin-bottom:6px">כבר קיים ליד דומה: <a href="#" data-card="${meta.duplicate.id}">${esc(meta.duplicate.organization)}</a></div>` : ''}
    <datalist id="ad-segs">${segs.map((s) => `<option value="${esc(s)}">`).join('')}</datalist>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:4px 12px">${ADD_FIELDS.map(inp).join('')}</div>
    ${others.length ? `<div class="muted" style="font-size:12px;margin-top:6px">כתובות נוספות בדף: ${others.map((e) => `<a href="#" class="ad-em" dir="ltr">${esc(e)}</a>`).join(' · ')}</div>` : ''}
    <label>הערה<textarea id="ad-notes" rows="2" style="width:100%"></textarea></label>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px"><button class="btn ghost" id="ad-cancel">ביטול</button><button class="btn primary" id="ad-save">שמירת ליד</button></div>`);
  const read = () => Object.fromEntries(ADD_FIELDS.map(([k]) => [k, $(`#ad-${k}`).value]));
  $('#ad-cancel').onclick = dlgClose;
  $('#dlg-box').querySelectorAll('.ad-em').forEach((a) => { a.onclick = (e) => { e.preventDefault(); $('#ad-email').value = a.textContent; }; });
  const dupLink = $('#dlg-box').querySelector('[data-card]');
  if (dupLink) dupLink.onclick = (e) => { e.preventDefault(); openCard(+dupLink.dataset.card); };
  $('#ad-url').onkeydown = (e) => { if (e.key === 'Enter') $('#ad-go').click(); };
  $('#ad-go').onclick = async () => {
    const url = $('#ad-url').value.trim();
    if (!url) return;
    $('#ad-go').disabled = true; $('#ad-msg').textContent = 'קורא את הדף...';
    try {
      const r = await api('/leads/extract', { method: 'POST', body: { url } });
      openAdd(r.draft, {
        url: r.url, emails: r.emails, duplicate: r.duplicate,
        msg: r.source === 'ai' ? 'השדות מולאו אוטומטית. בדוק ותקן לפני שמירה.' : `השדות מולאו חלקית (בלי AI${r.error ? `: ${r.error}` : ''}). השלם ידנית.`,
      });
    } catch (e) { $('#ad-go').disabled = false; $('#ad-msg').textContent = `לא הצלחתי לקרוא את הדף (${e.message}). אפשר למלא ידנית.`; }
  };
  const save = async (force) => {
    const body = { ...read(), notes: $('#ad-notes').value, sourceUrl: $('#ad-url').value.trim(), force };
    if (!body.organization.trim()) { toast('חסר שם ארגון', true); return; }
    try {
      const lead = await api('/leads', { method: 'POST', body });
      toast('הליד נוסף'); await load(); openCard(lead.id);
    } catch (e) {
      if (e.data && e.data.error === 'duplicate_lead' && !force) {
        if (confirm(`כבר קיים ליד: ${e.data.duplicate.organization}. להוסיף בכל זאת?`)) save(true);
      } else toast(e.message, true);
    }
  };
  $('#ad-save').onclick = () => save(false);
  if (!meta.url) $('#ad-url').focus();
}
$('#add').onclick = () => openAdd();
// ---------- Customer card ----------
const ACT = {
  sent: ['✉', 'מייל נשלח'], delivered: ['✓', 'נמסר'], opened: ['👁', 'נפתח'], clicked: ['↗', 'הקלקה על קישור'],
  bounced: ['⚠', 'חזר'], failed: ['⚠', 'השליחה נכשלה'], replied: ['↩', 'השיב'], template: ['▤', 'תבנית'],
  edited: ['✎', 'הליד נערך'], email_changed: ['✎', 'המייל שונה'], follow_up: ['⏰', 'מעקב'], note: ['📝', 'הערה'], reply_sent: ['↪', 'תשובה נשלחה'], reminder: ['🔔', 'תזכורת נשלחה'], code_sent: ['🔑', 'קוד גישה נשלח'], closed: ['⛔', 'הליד נסגר'], reopened: ['↺', 'הליד נפתח מחדש'], created: ['＋', 'נוסף ידנית'],
};
async function openCard(id) {
  const l = leads.find((x) => x.id === id);
  if (!l) return;
  let acts = [];
  try { acts = await api(`/leads/${id}/activities`); } catch (e) { toast(e.message, true); }
  const lastIn = acts.find((a) => a.type === 'replied'), lastOut = acts.find((a) => a.type === 'sent');
  const firstLine = (a) => String((a && a.detail) || '').split('\n')[0].replace(/\s+\[template:.*$/, '');
  const base = firstLine(lastIn) || firstLine(lastOut);
  // Never mailed: the box writes the first email (optionally from the lead's attached template), not a reply.
  const fresh = l.emailStatus !== 'sent' && !acts.some((a) => ['sent', 'first_sent', 'reply_sent'].includes(a.type));
  const ftpl = fresh ? templates.find((t) => t.id === l.templateId) : null;
  let draft = null;
  try { draft = await api(`/leads/${id}/draft`); } catch { /* no draft */ }
  const defSubject = ftpl ? ftpl.subject : base ? (/^re:/i.test(base) ? base : `Re: ${base}`) : '';
  const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
  const row = ([h, v]) => (v ? `<div style="display:flex;gap:8px"><span class="muted" style="min-width:110px">${h}</span><span dir="ltr">${esc(v)}</span></div>` : '');
  dlgOpen(`<div style="display:flex;justify-content:space-between;align-items:start;gap:8px">
      <h3 style="margin:0">${esc(l.organization)} ${l.priority ? `<span class="pb ${esc(l.priority)}">${esc(l.priority)}</span>` : ''}</h3>
      <div><button class="btn sm" id="cd-edit">✎ עריכה</button> <button class="btn sm" id="cd-close-lead">${l.closedAt ? '↺ פתיחה מחדש' : '⛔ סגירה ועצירה'}</button> <button class="btn sm" id="cd-del" style="color:var(--danger-text)">🗑 מחיקה</button> <button class="btn sm" id="cd-close" aria-label="סגירה">✕</button></div></div>
    <div style="margin:8px 0;display:grid;gap:3px;font-size:13px">
      ${[['איש קשר', l.contactName], ['מדינה', l.country], ['סוג', l.segment], ['התאמת מוצר', FIT[l.productFit] || l.productFit], ['אתר', l.website], ['מייל', l.email], ['טלפון', l.phone],
        ['למה יקנו', l.whyTheydBuy], ['תבנית', l.template && l.template.name], ['סיבת סגירה', l.closedAt && l.closedReason], ['סטטוס מייל', STATUS[l.emailStatus] || l.emailStatus],
        ['נשלח לאחרונה', fmt(l.lastEmailedAt)], ['פתיחות / הקלקות', `${l.openCount || 0} / ${l.clickCount || 0}`], ['תזכורות', `${l.reminderCount || 0}${l.lastReminderAt ? ` (אחרונה ${fmt(l.lastReminderAt)})` : ''}`], ['קוד גישה', l.accessCode ? `${l.accessCode} (${fmt(l.codeSentAt)})` : ''], ['השיב', fmt(l.repliedAt)]].map(row).join('')}
    </div>
    <div class="toolbar wrap" style="margin:10px 0">
      <label style="margin:0">תאריך מעקב <input type="date" id="cd-fu" value="${day(l.followUpAt)}"></label>
      <button class="btn sm" id="cd-fu-save">שמירת תאריך</button>
      <button class="btn sm" id="cd-fu-clear">ניקוי</button>
    </div>
    <div class="toolbar wrap" style="margin:6px 0">
      <button class="btn sm" id="cd-remind" ${l.email && !l.repliedAt && !l.closedAt ? '' : 'disabled'}>🔔 שלח תזכורת עכשיו</button>
      <button class="btn sm" id="cd-code" ${l.email ? '' : 'disabled'}>🔑 שלח קוד גישה</button>
    </div>
    <h4 style="margin:12px 0 6px">${fresh ? '✉ מייל ראשון' : 'תשובה'}</h4>
    <input id="cd-rsub" dir="ltr" style="width:100%;margin-bottom:6px" placeholder="נושא" value="${esc(defSubject)}">
    <textarea id="cd-rbody" rows="7" dir="ltr" style="width:100%" placeholder="${fresh ? 'כתוב כאן את המייל, או טען תבנית. החתימה נוספת אוטומטית.' : 'כתוב כאן את התשובה, או לחץ על הצעת תשובה לקבלת טיוטה מ-Claude. החתימה נוספת אוטומטית.'}">${esc(ftpl ? ftpl.body : '')}</textarea>
    ${toolsHtml('cr')}
    <div class="toolbar wrap" style="margin:6px 0 4px">
      <button class="btn sm${fresh ? ' hidden' : ''}" id="cd-suggest">✨ הצעת תשובה</button>
      <button class="btn primary sm" id="cd-rsend" ${l.email ? '' : 'disabled'}>${fresh ? 'שליחת מייל ל-' : 'שליחת תשובה ל-'}<span dir="ltr">${esc(l.email || '')}</span></button>
      <button class="btn sm" id="cd-dsave">💾 שמירת טיוטה</button>
      <button class="btn ghost sm${draft ? '' : ' hidden'}" id="cd-ddel">מחיקת טיוטה</button>
      <span class="muted" id="cd-rhint" style="font-size:12px">${draft ? `טיוטה שמורה מ-${esc(fmt(draft.savedAt))}` : ''}</span>
    </div>
    <label style="margin-top:12px">הוספת הערה (שיחה, פגישה, תשובה, כל דבר)
      <textarea id="cd-note" rows="2" dir="ltr" style="width:100%"></textarea></label>
    <div class="toolbar" style="margin:6px 0 12px"><button class="btn primary sm" id="cd-note-add">הוספת הערה</button></div>
    <h4 style="margin:0 0 6px">היסטוריה</h4>
    <div id="cd-acts" style="max-height:260px;overflow:auto;border:1px solid var(--line);border-radius:8px">
      ${acts.map((a) => { const [ico, lab] = ACT[a.type] || ['•', a.type];
        return `<div style="padding:6px 10px;border-bottom:1px solid var(--line);font-size:13px"><span class="muted" style="font-size:12px">${esc(fmt(a.createdAt))}</span>
          <b>${ico} ${lab}</b>${a.detail ? `<div dir="ltr" style="white-space:pre-wrap;color:var(--ink)">${esc(a.detail)}</div>` : ''}</div>`; }).join('')
        || '<div class="muted" style="padding:10px">אין עדיין פעילות</div>'}
    </div>`);
  if (draft) { $('#cd-rsub').value = draft.subject; $('#cd-rbody').value = draft.body; }
  const crRefresh = wireTools('cr', '#cd-rsub', '#cd-rbody', id);
  let auto = null, sentDone = false, lastSaved = draft ? `${draft.subject}\u0000${draft.body}` : null;
  const autoSave = async () => {
    clearTimeout(auto); auto = null;
    if (sentDone) return;
    const subject = $('#cd-rsub') ? $('#cd-rsub').value : null, body = $('#cd-rbody') ? $('#cd-rbody').value : null;
    if (subject === null || `${subject}\u0000${body}` === lastSaved) return;
    try {
      const d = await api(`/leads/${id}/draft`, { method: 'PUT', body: { subject, body } });
      lastSaved = `${subject}\u0000${body}`;
      if ($('#cd-rhint')) $('#cd-rhint').textContent = d ? `נשמר אוטומטית ${fmt(d.savedAt)}` : '';
      if ($('#cd-ddel')) $('#cd-ddel').classList.toggle('hidden', !d);
      if (l.hasDraft !== !!d) { l.hasDraft = !!d; render(); }
    } catch { if ($('#cd-rhint')) $('#cd-rhint').textContent = 'השמירה האוטומטית נכשלה'; }
  };
  const schedule = () => { clearTimeout(auto); auto = setTimeout(autoSave, 2000); };
  $('#cd-rsub').addEventListener('input', schedule); $('#cd-rbody').addEventListener('input', schedule);
  $('#cd-dsave').onclick = async () => {
    try {
      const d = await api(`/leads/${id}/draft`, { method: 'PUT', body: { subject: $('#cd-rsub').value, body: $('#cd-rbody').value } });
      $('#cd-rhint').textContent = d ? `הטיוטה נשמרה ${fmt(d.savedAt)}` : 'אין מה לשמור';
      $('#cd-ddel').classList.toggle('hidden', !d);
      if (l.hasDraft !== !!d) { l.hasDraft = !!d; render(); }
      toast(d ? 'הטיוטה נשמרה' : 'הטיוטה ריקה');
    } catch (e) { toast(e.message, true); }
  };
  $('#cd-ddel').onclick = async () => {
    if (!confirm('למחוק את הטיוטה השמורה?')) return;
    try { await api(`/leads/${id}/draft`, { method: 'DELETE' }); l.hasDraft = false; render(); openCard(id); toast('הטיוטה נמחקה'); } catch (e) { toast(e.message, true); }
  };
  $('#cd-close').onclick = () => { if (auto) autoSave(); dlgClose(); };
  $('#cd-edit').onclick = () => editLead(id);
  $('#cd-del').onclick = () => deleteLead(id);
  $('#cd-close-lead').onclick = async () => {
    const closing = !l.closedAt;
    let reason = null;
    if (closing) {
      reason = prompt(`סיבת הסגירה של "${l.organization}" (למשל: לא מעוניין, אין תקציב, בחרו פתרון אחר). הליד ייסגר גם בדואר ובכל סבב, ואפשר לפתוח מחדש.`, 'לא מעוניין');
      if (reason === null) return;
    }
    try { await api('/leads/close', { method: 'POST', body: { ids: [id], closed: closing, reason } }); await load(); toast(closing ? 'הליד נסגר' : 'הליד נפתח מחדש'); openCard(id); } catch (e) { toast(e.message, true); }
  };
  const saveFu = async (v) => { try { await api(`/leads/${id}`, { method: 'PUT', body: { followUpAt: v } }); await load(); toast('נשמר'); openCard(id); } catch (e) { toast(e.message, true); } };
  $('#cd-fu-save').onclick = () => saveFu($('#cd-fu').value || null);
  $('#cd-fu-clear').onclick = () => saveFu(null);
  $('#cd-remind').onclick = async () => {
    let pv;
    try { pv = await api(`/leads/${id}/remind/preview`); } catch (e) { toast(e.message, true); return; }
    dlgOpen(`<h3 style="margin-top:0">🔔 תזכורת ${pv.n} · תצוגה מקדימה</h3>
      <div class="muted" style="margin-bottom:8px">אל: <span dir="ltr">${esc(pv.to)}</span> · הנוסח נבחר לפי פתיחות והקלקות (${esc(pv.segment)}). אפשר לערוך לפני שליחה, והחתימה נוספת אוטומטית.</div>
      <label>נושא<input id="rp-subject" dir="ltr" style="width:100%" value="${esc(pv.subject)}"></label>
      <label style="margin-top:8px">תוכן<textarea id="rp-body" rows="12" dir="ltr" style="width:100%">${esc(pv.body)}</textarea></label>
      ${toolsHtml('rpt')}
      <div class="toolbar" style="margin-top:10px"><button class="btn primary" id="rp-send">שלח עכשיו</button><button class="btn" id="rp-back">חזרה לכרטיס</button></div>`);
    wireTools('rpt', '#rp-subject', '#rp-body', id, { footer: true });
    $('#rp-back').onclick = () => openCard(id);
    $('#rp-send').onclick = async () => {
      if (!confirm(`לשלוח את התזכורת ל-${pv.to}?`)) return;
      try { const r = await api(`/leads/${id}/remind`, { method: 'POST', body: { subject: $('#rp-subject').value, body: $('#rp-body').value } }); toast(`תזכורת ${r.n} נשלחה`); await load(); openCard(id); } catch (e) { toast(e.message, true); }
    };
  };
  $('#cd-code').onclick = async () => {
    let pv;
    try { pv = await api(`/leads/${id}/code/preview`); } catch (e) { toast(e.message, true); return; }
    let cur = pv.code;
    dlgOpen(`<h3 style="margin-top:0">🔑 קוד גישה · תצוגה מקדימה</h3>
      <div class="muted" style="margin-bottom:8px">אל: <span dir="ltr">${esc(pv.to)}</span> · אפשר לערוך את הקוד, הנושא והתוכן לפני שליחה. החתימה נוספת אוטומטית.</div>
      <label>קוד גישה<input id="cp-code" dir="ltr" style="width:100%" value="${esc(pv.code)}"></label>
      <label style="margin-top:8px">נושא<input id="cp-subject" dir="ltr" style="width:100%" value="${esc(pv.subject)}"></label>
      <label style="margin-top:8px">תוכן<textarea id="cp-body" rows="12" dir="ltr" style="width:100%">${esc(pv.body)}</textarea></label>
      ${toolsHtml('cpt')}
      <div class="toolbar" style="margin-top:10px"><button class="btn primary" id="cp-send">שלח עכשיו</button><button class="btn" id="cp-back">חזרה לכרטיס</button></div>`);
    $('#cp-code').oninput = () => { const n = $('#cp-code').value.trim(); if (n && cur) $('#cp-body').value = $('#cp-body').value.split(cur).join(n); if (n) cur = n; };
    wireTools('cpt', '#cp-subject', '#cp-body', id);
    $('#cp-back').onclick = () => openCard(id);
    $('#cp-send').onclick = async () => {
      const code = $('#cp-code').value.trim();
      if (!code) { toast('חסר קוד גישה', true); return; }
      if (!confirm(`לשלוח קוד גישה ל-${pv.to}?`)) return;
      try { const r = await api(`/leads/${id}/code`, { method: 'POST', body: { code, subject: $('#cp-subject').value, body: $('#cp-body').value } }); toast(`הקוד ${r.code} נשלח`); await load(); openCard(id); } catch (e) { toast(e.message, true); }
    };
  };
  $('#cd-suggest').onclick = async () => {
    const b = $('#cd-suggest'); b.disabled = true; $('#cd-rhint').textContent = 'מנסח...';
    try {
      const r = await api(`/leads/${id}/suggest`, { method: 'POST', body: {} });
      $('#cd-rbody').value = r.text; crRefresh(); schedule();
      $('#cd-rhint').textContent = r.source === 'ai' ? (acts.some((a) => a.type === 'replied') ? 'טיוטה שעונה לתשובה שלהם. לעבור ולערוך לפני שליחה.' : 'הם עוד לא השיבו, אז זו טיוטת מעקב. לעבור ולערוך לפני שליחה.') : `תבנית גנרית, לא תשובה לתוכן שלהם: ניסוח ה-AI נכשל${r.error ? ` (${r.error}${r.error === 'llm_401' ? ': מפתח ANTHROPIC_API_KEY ב-Railway חסר או לא תקין' : ''})` : ''}.`;
      if (r.source !== 'ai') toast('ה-AI לא זמין, זו תבנית גנרית', true);
    } catch (e) { $('#cd-rhint').textContent = ''; toast(e.message, true); }
    b.disabled = false;
  };
  $('#cd-rsend').onclick = async () => {
    const subject = $('#cd-rsub').value.trim(), body = $('#cd-rbody').value.trim();
    if (!subject || !body) { toast('חובה למלא נושא ותוכן', true); return; }
    if (!confirm(`${fresh ? 'לשלוח את המייל' : 'לשלוח את התשובה'} ל-${l.email}?`)) return;
    clearTimeout(auto); auto = null;
    try { await api(`/leads/${id}/reply`, { method: 'POST', body: { subject, body } }); sentDone = true; toast(fresh ? 'המייל נשלח' : 'התשובה נשלחה'); await load(); openCard(id); } catch (e) { toast(e.message, true); }
  };
  $('#cd-note-add').onclick = async () => {
    const detail = $('#cd-note').value.trim();
    if (!detail) return;
    try { await api(`/leads/${id}/activities`, { method: 'POST', body: { detail } }); openCard(id); } catch (e) { toast(e.message, true); }
  };
}

// ---------- Reminders dialog ----------
const SEG = { hot: 'הקליק', warm: 'פתח', cold: 'לא פתח' };
async function openReminders() {
  let r;
  try { r = await api('/reminders'); } catch (e) { toast(e.message, true); return; }
  dlgOpen(`<div style="display:flex;justify-content:space-between;align-items:start"><h3 style="margin:0">תזכורות אוטומטיות</h3><button class="btn sm" id="rm-close" aria-label="סגירה">✕</button></div>
    <p class="muted" style="font-size:13px">ליד ששלחו לו ולא השיב מקבל עד ${r.max} תזכורות. הניסוח והמרווח נקבעים לפי ההתנהגות: <b>הקליק</b> אחרי ${r.waitDays.hot} ימים (הצעה לשיחה או לקוד גישה), <b>פתח בלי קליק</b> אחרי ${r.waitDays.warm} ימים, <b>לא פתח</b> אחרי ${r.waitDays.cold} ימים. שליחה ראשון עד חמישי, 09:00 עד 17:00 שעון ישראל, עד ${r.dailyCap} ביום. תשובה או חזרת מייל עוצרות הכול.</p>
    <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="rm-on" ${r.enabled ? 'checked' : ''}> <b>שליחה אוטומטית פעילה</b></label>
    <div class="muted" style="font-size:12px;margin:4px 0">${r.inWindow ? 'כרגע בתוך חלון השליחה.' : 'כרגע מחוץ לחלון השליחה.'}</div>
    <h4 style="margin:12px 0 6px">מועמדים לתזכורת כעת (${r.due.length})</h4>
    <div style="max-height:260px;overflow:auto;border:1px solid var(--line);border-radius:8px">
      ${r.due.map((d) => `<div style="padding:6px 10px;border-bottom:1px solid var(--line);font-size:13px"><b>${esc(d.organization)}</b> <span class="muted" dir="ltr">${esc(d.email)}</span> · ${SEG[d.segment]} · תזכורת ${d.n}/${r.max} · פתיחות ${d.openCount}, הקלקות ${d.clickCount}</div>`).join('') || '<div class="muted" style="padding:10px">אין כרגע לידים שהגיע זמנם</div>'}
    </div>
    <div class="toolbar" style="margin-top:10px"><button class="btn primary" id="rm-run" ${r.due.length && r.emailConfigured ? '' : 'disabled'}>שלח את כל ${r.due.length} עכשיו</button> <button class="btn" id="rm-tpl">✎ עריכת נוסחים</button></div>`);
  $('#rm-tpl').onclick = openReminderTemplates;
  $('#rm-close').onclick = dlgClose;
  $('#rm-on').onchange = async (e) => {
    try { await api('/reminders', { method: 'PUT', body: { enabled: e.target.checked } }); toast(e.target.checked ? 'התזכורות האוטומטיות הופעלו' : 'התזכורות האוטומטיות כובו'); } catch (err) { toast(err.message, true); e.target.checked = !e.target.checked; }
  };
  $('#rm-run').onclick = async () => {
    if (!confirm(`לשלוח עכשיו תזכורת ל-${r.due.length} לידים?`)) return;
    try { const x = await api('/reminders/run', { method: 'POST', body: {} }); toast(`נשלחו ${x.sent}${x.failed ? `, נכשלו ${x.failed}` : ''}`); await load(); openReminders(); } catch (err) { toast(err.message, true); }
  };
}
$('#rem').onclick = openReminders;

async function openReminderTemplates() {
  let t;
  try { t = await api('/reminders/templates'); } catch (e) { toast(e.message, true); return; }
  const SEGS = [['hot', 'הקליק על קישור'], ['warm', 'פתח בלי קליק'], ['cold', 'לא פתח']];
  const vars = '{{Organization}} {{Country}} {{Segment}} {{Website}}';
  dlgOpen(`<div style="display:flex;justify-content:space-between;align-items:start"><h3 style="margin:0">נוסחי תזכורות</h3><button class="btn sm" id="rt-close" aria-label="סגירה">✕</button></div>
    <p class="muted" style="font-size:13px">שלוש תזכורות לכל קבוצה. משתנים: <span dir="ltr">${vars}</span>. החתימה והערת ההסרה נוספות אוטומטית.</p>
    <select id="rt-seg">${SEGS.map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select>
    <div id="rt-list"></div>
    <div class="toolbar" style="margin-top:10px"><button class="btn primary" id="rt-save">שמירה</button> <button class="btn" id="rt-reset">איפוס לברירת מחדל</button> <button class="btn ghost" id="rt-back">חזרה</button></div>`);
  const grab = () => { const seg = cur; document.querySelectorAll('#rt-list .rt-i').forEach((el, i) => { t[seg][i] = { subject: el.querySelector('.rt-s').value, body: el.querySelector('.rt-b').value }; }); };
  const draw = () => {
    const seg = $('#rt-seg').value;
    $('#rt-list').innerHTML = t[seg].map((x, i) => `<div class="rt-i" style="margin-top:8px"><b>תזכורת ${i + 1}</b>
      <input class="rt-s" dir="ltr" style="width:100%;margin:4px 0" value="${esc(x.subject)}">
      <textarea class="rt-b" dir="ltr" rows="7" style="width:100%">${esc(x.body)}</textarea></div>`).join('');
  };
  let cur = $('#rt-seg').value;
  draw();
  $('#rt-seg').onchange = () => { grab(); cur = $('#rt-seg').value; draw(); };
  $('#rt-close').onclick = dlgClose;
  $('#rt-back').onclick = openReminders;
  $('#rt-save').onclick = async () => { grab(); try { t = await api('/reminders/templates', { method: 'PUT', body: t }); toast('הנוסחים נשמרו'); } catch (e) { toast(e.message, true); } };
  $('#rt-reset').onclick = async () => { if (!confirm('לאפס את כל הנוסחים לברירת המחדל?')) return; try { t = await api('/reminders/templates', { method: 'DELETE' }); draw(); toast('אופס'); } catch (e) { toast(e.message, true); } };
}

// ---------- Edit a lead ----------
const EDIT_FIELDS = [['organization', 'ארגון'], ['contactName', 'שם איש קשר (פנייה אישית: Dear <שם>, במקום Dear <ארגון> team,)'], ['country', 'מדינה'], ['segment', 'סוג'], ['productFit', 'התאמת מוצר (Course / Simulator / Both)'],
  ['whyTheydBuy', 'למה יקנו'], ['website', 'אתר'], ['email', 'מייל (כמה כתובות: מופרדות ב-;)'], ['phone', 'טלפון'], ['priority', 'עדיפות (A / B / C)']];
async function deleteLead(id) {
  const l = leads.find((x) => x.id === id);
  if (!l || !confirm(`למחוק לצמיתות את "${l.organization}" וכל ההיסטוריה שלו? אי אפשר לשחזר.`)) return;
  try { await api(`/leads/${id}`, { method: 'DELETE' }); selected.delete(id); dlgClose(); await load(); toast('הליד נמחק'); } catch (e) { toast(e.message, true); }
}

function editLead(id) {
  const l = leads.find((x) => x.id === id);
  if (!l) return;
  dlgOpen(`<h3 style="margin-top:0">עריכת ליד</h3>
    ${EDIT_FIELDS.map(([k, h]) => `<label>${h}${k === 'whyTheydBuy'
      ? `<textarea data-f="${k}" rows="3" dir="ltr" style="width:100%">${esc(l[k])}</textarea>`
      : `<input data-f="${k}" value="${esc(l[k])}" dir="ltr" style="width:100%">`}</label>`).join('')}
    <p class="muted" style="font-size:12px;margin:8px 0 0">שינוי כתובת המייל מאפס את סטטוס השליחה של הליד, כך שאפשר לשלוח אליו שוב.</p>
    <div class="toolbar" style="margin-top:12px"><button class="btn primary" id="le-save">שמירה</button><button class="btn" id="le-cancel">ביטול</button><button class="btn" id="le-del" style="color:var(--danger-text);margin-inline-start:auto">🗑 מחיקת ליד</button></div>`);
  $('#le-cancel').onclick = dlgClose;
  $('#le-del').onclick = () => deleteLead(id);
  $('#le-save').onclick = async () => {
    const body = {};
    document.querySelectorAll('#dlg-box [data-f]').forEach((el) => { body[el.dataset.f] = el.value; });
    try { await api(`/leads/${id}`, { method: 'PUT', body }); dlgClose(); await load(); toast('הליד נשמר'); } catch (e) { toast(e.message, true); }
  };
}

$('#tbl').addEventListener('click', (e) => {
  const th = e.target.closest('th[data-k]');
  if (th) { sortDir = sortKey === th.dataset.k ? -sortDir : 1; sortKey = th.dataset.k; render(); return; }
  if (e.target.id === 'chk-page') { filtered().forEach((l) => (e.target.checked ? selected.add(l.id) : selected.delete(l.id))); render(); return; }
  const cb = e.target.closest('[data-card]');
  if (cb) { e.preventDefault(); openCard(+cb.dataset.card); return; }
  const eb = e.target.closest('[data-edit]');
  if (eb) { editLead(+eb.dataset.edit); return; }
  if (e.target.classList.contains('rc')) {
    const id = +e.target.dataset.id;
    if (e.target.checked) selected.add(id); else selected.delete(id);
    render();
  }
});

if (new URLSearchParams(location.search).has('embed')) document.body.classList.add('embed');
(async () => {
  const r = await fetch('/auth/me');
  if (!r.ok) { location.href = '/login'; return; }
  csrf = (await r.json()).csrf;
  const v = await api('/variables');
  variables = v.variables; emailConfigured = v.emailConfigured;
  if (v.setupMessage) { const w = $('#cfgwarn'); w.textContent = v.setupMessage; w.classList.remove('hidden'); }
  await load();
  const deep = Number(new URLSearchParams(location.search).get('card'));
  if (deep) openCard(deep);
})().catch((e) => toast(e.message, true));
