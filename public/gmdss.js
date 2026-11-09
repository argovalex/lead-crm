/* GMDSS Outreach Leads page. Vanilla JS, same conventions as app.js. */
let csrf = '';
let leads = [];
let variables = [];
let emailConfigured = true;
let sortKey = 'id', sortDir = 1;
const selected = new Set();
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COLS = [
  ['organization', 'Organization'], ['country', 'Country'], ['segment', 'Segment'], ['productFit', 'Product Fit'],
  ['whyTheydBuy', "Why They'd Buy"], ['website', 'Website'], ['email', 'Email'], ['phone', 'Phone'], ['priority', 'Priority'],
  ['emailStatus', 'Email Status'], ['lastEmailedAt', 'Last Emailed'], ['createdAt', 'Created'], ['id', 'ID'],
];
const LTR = new Set(['website', 'email', 'phone']);
const TEXT = ['organization', 'country', 'segment', 'productFit', 'whyTheydBuy', 'website', 'email', 'phone', 'priority', 'emailStatus'];
const fmt = (d) => (d ? new Date(d).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : '');

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
  const f = { country: $('#f-country').value, segment: $('#f-segment').value, productFit: $('#f-fit').value, priority: $('#f-priority').value };
  const rows = leads.filter((l) => {
    for (const k in f) if (f[k] && l[k] !== f[k]) return false;
    return !q || TEXT.some((k) => (l[k] || '').toLowerCase().includes(q));
  });
  return rows.sort((a, b) => {
    const x = a[sortKey] ?? '', y = b[sortKey] ?? '';
    if (x === y) return 0;
    if (x === '') return 1;
    if (y === '') return -1; // empty values always last
    return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y), 'en', { numeric: true })) * sortDir;
  });
}

function cell(l, k) {
  const v = l[k];
  if (v == null || v === '') return '<span class="muted-cell">—</span>';
  if (k === 'priority') return `<span class="pb ${esc(v)}">${esc(v)}</span>`;
  if (k === 'website') return `<a href="${esc(v)}" target="_blank" rel="noopener noreferrer">${esc(v.replace(/^https?:\/\/(www\.)?/, ''))}</a>`;
  if (k === 'email') return `<a href="mailto:${esc(v)}">${esc(v)}</a>`;
  if (k === 'phone') return `<a href="tel:${esc(v.replace(/[^\d+]/g, ''))}">${esc(v)}</a>`;
  if (k === 'emailStatus') return `<span class="st ${esc(v)}" ${l.lastError ? `title="${esc(l.lastError)}"` : ''}>${esc(v)}</span>`;
  if (k === 'lastEmailedAt' || k === 'createdAt') return esc(fmt(v));
  return esc(v);
}

function render() {
  const rows = filtered();
  $('#tbl thead').innerHTML = `<tr><th><input type="checkbox" id="chk-page" title="בחר את המוצגים"></th>${COLS.map(([k, h]) =>
    `<th data-k="${k}" class="${LTR.has(k) ? 'ltr' : ''}">${h}${sortKey === k ? (sortDir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr>`;
  $('#tbl tbody').innerHTML = rows.map((l) => `<tr>
    <td><input type="checkbox" class="rc" data-id="${l.id}" ${selected.has(l.id) ? 'checked' : ''} ${l.email ? '' : 'disabled title="אין אימייל"'}></td>
    ${COLS.map(([k]) => `<td class="${LTR.has(k) ? 'ltr' : ''} ${k === 'whyTheydBuy' ? 'wide' : ''}">${cell(l, k)}</td>`).join('')}</tr>`).join('')
    || `<tr><td colspan="${COLS.length + 1}" class="muted">אין תוצאות</td></tr>`;
  $('#count').textContent = `${rows.length} / ${leads.length}`;
  $('#sel-n').textContent = selected.size;
  $('#send').disabled = !selected.size;
}

function fillFilters() {
  const opts = (k) => [...new Set(leads.map((l) => l[k]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  for (const [id, k, label] of [['#f-country', 'country', 'Country'], ['#f-segment', 'segment', 'Segment']]) {
    const cur = $(id).value;
    $(id).innerHTML = `<option value="">${label}: all</option>` + opts(k).map((o) => `<option>${esc(o)}</option>`).join('');
    $(id).value = cur;
  }
}

async function load() {
  leads = await api('/leads');
  fillFilters();
  for (const id of [...selected]) { const l = leads.find((x) => x.id === id); if (!l || !l.email) selected.delete(id); }
  render();
}

// ---------- Send dialog ----------
const DEFAULT_SUBJECT = 'GMDSS training tools for {{Organization}}';
const DEFAULT_BODY = `Hello,

I am reaching out to {{Organization}} ({{Country}}). {{Why They'd Buy}}

I built a GMDSS exam-prep course and simulator and think it could fit your {{Segment}} work. Details: {{Website}}

Best regards,
Alex`;
let lastField = null;

async function openDialog() {
  const ids = [...selected];
  const first = leads.find((l) => l.id === ids[0]);
  const box = $('#dlg-box');
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('gmdss_tpl') || 'null'); } catch { /* storage unavailable */ }
  saved = saved || { subject: DEFAULT_SUBJECT, body: DEFAULT_BODY };
  box.innerHTML = `<h3 style="margin-top:0">Send email · ${ids.length} נבחרו</h3>
    ${emailConfigured ? '' : '<p class="warn">שליחה לא מוגדרת בשרת. תצוגה מקדימה זמינה, שליחה תיכשל עם הודעת הגדרה.</p>'}
    <label>Subject<input id="t-sub" dir="ltr" style="width:100%" value="${esc(saved.subject)}"></label>
    <label>Body<textarea id="t-body" dir="ltr" rows="10">${esc(saved.body)}</textarea></label>
    <div class="muted">משתנים (לחיצה מכניסה בסמן):</div>
    <div class="vars">${variables.map((v) => `<button type="button" class="btn sm" data-v="${esc(v)}">{{${esc(v)}}}</button>`).join('')}</div>
    <div class="muted">תצוגה מקדימה ל: <b dir="ltr">${esc(first.organization)}</b></div>
    <div class="prev"><div><b>Subject:</b> <span id="p-sub" dir="ltr"></span></div><hr><div id="p-body"></div><div id="p-warn" class="warn"></div></div>
    <hr>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <input id="t-to" type="email" dir="ltr" placeholder="כתובת לבדיקה" style="min-width:220px">
      <button class="btn" id="t-test">Send test to me</button>
      <span style="flex:1"></span>
      <label class="chk"><input type="checkbox" id="t-resend"> כלול גם מי שכבר נשלח</label>
      <button class="btn ghost" id="t-cancel">ביטול</button>
      <button class="btn primary" id="t-send">שלח ל-${ids.length}</button>
    </div>`;
  $('#dlg').classList.remove('hidden');
  lastField = $('#t-body');
  $('#t-sub').onfocus = () => { lastField = $('#t-sub'); };
  $('#t-body').onfocus = () => { lastField = $('#t-body'); };
  let timer;
  async function preview() {
    try { localStorage.setItem('gmdss_tpl', JSON.stringify({ subject: $('#t-sub').value, body: $('#t-body').value })); } catch { /* ignore */ }
    try {
      const p = await api('/preview', { method: 'POST', body: { subject: $('#t-sub').value, body: $('#t-body').value, leadId: first.id } });
      $('#p-sub').textContent = p.subject;
      $('#p-body').innerHTML = p.html;
      $('#p-warn').textContent = p.unknown.length ? `משתנים לא מוכרים: ${p.unknown.map((u) => `{{${u}}}`).join(', ')}` : '';
    } catch (e) { $('#p-warn').textContent = e.message; }
  }
  const refresh = () => { clearTimeout(timer); timer = setTimeout(preview, 250); };
  $('#t-sub').oninput = refresh;
  $('#t-body').oninput = refresh;
  box.querySelectorAll('[data-v]').forEach((b) => {
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = () => {
      const f = lastField, tok = `{{${b.dataset.v}}}`;
      const s = f.selectionStart ?? f.value.length, e = f.selectionEnd ?? s;
      f.value = f.value.slice(0, s) + tok + f.value.slice(e);
      f.focus(); f.setSelectionRange(s + tok.length, s + tok.length); refresh();
    };
  });
  preview();
  const close = () => { $('#dlg').classList.add('hidden'); };
  $('#t-cancel').onclick = close;
  $('#t-test').onclick = async () => {
    try {
      const r = await api('/test-email', { method: 'POST', body: { subject: $('#t-sub').value, body: $('#t-body').value, leadId: first.id, to: $('#t-to').value } });
      toast(`נשלח בדיקה ל-${r.sentTo}`);
    } catch (e) { toast(e.message === 'invalid_email' ? 'כתובת בדיקה לא תקינה' : e.message, true); }
  };
  $('#t-send').onclick = async () => {
    const includeSent = $('#t-resend').checked;
    const n = ids.filter((id) => { const l = leads.find((x) => x.id === id); return l.email && (includeSent || l.emailStatus !== 'sent'); }).length;
    if (!n) return toast('אין נמענים זכאים', true);
    if (!confirm(`לשלוח ${n} מיילים אמיתיים (מייל נפרד לכל ליד)? הפעולה לא הפיכה.`)) return;
    try {
      const r = await api('/send', { method: 'POST', body: { ids, subject: $('#t-sub').value, body: $('#t-body').value, includeSent } });
      toast(`בתור: ${r.queued}, דולגו: ${r.skipped}, קצב ${r.perMinute}/דקה`);
      selected.clear(); close(); poll();
    } catch (e) { toast(e.message, true); }
  };
}

async function poll() {
  await load();
  const { sending } = await api('/send/status');
  if (sending) setTimeout(poll, 4000);
}

// ---------- Wiring ----------
['#q', '#f-country', '#f-segment', '#f-fit', '#f-priority'].forEach((s) => { $(s).oninput = render; });
$('#reset').onclick = () => { ['#q', '#f-country', '#f-segment', '#f-fit', '#f-priority'].forEach((s) => { $(s).value = ''; }); render(); };
$('#sel-all').onclick = () => { filtered().filter((l) => l.email).forEach((l) => selected.add(l.id)); render(); };
$('#sel-none').onclick = () => { selected.clear(); render(); };
$('#send').onclick = openDialog;
$('#tbl').addEventListener('click', (e) => {
  const th = e.target.closest('th[data-k]');
  if (th) { sortDir = sortKey === th.dataset.k ? -sortDir : 1; sortKey = th.dataset.k; render(); return; }
  if (e.target.id === 'chk-page') { filtered().filter((l) => l.email).forEach((l) => (e.target.checked ? selected.add(l.id) : selected.delete(l.id))); render(); return; }
  if (e.target.classList.contains('rc')) {
    const id = +e.target.dataset.id;
    if (e.target.checked) selected.add(id); else selected.delete(id);
    $('#sel-n').textContent = selected.size; $('#send').disabled = !selected.size;
  }
});

(async () => {
  const r = await fetch('/auth/me');
  if (!r.ok) { location.href = '/login'; return; }
  csrf = (await r.json()).csrf;
  const v = await api('/variables');
  variables = v.variables; emailConfigured = v.emailConfigured;
  if (v.setupMessage) { const w = $('#cfgwarn'); w.textContent = v.setupMessage; w.classList.remove('hidden'); }
  await load();
})().catch((e) => toast(e.message, true));
