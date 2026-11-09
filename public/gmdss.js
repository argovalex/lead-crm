/* GMDSS Outreach Leads page. Vanilla JS, same conventions as app.js. */
let csrf = '';
let leads = [];
let templates = [];
let variables = [];
let emailConfigured = true;
let sortKey = 'id', sortDir = 1;
const selected = new Set();
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COLS = [
  ['organization', 'Organization'], ['country', 'Country'], ['segment', 'Segment'], ['productFit', 'Product Fit'],
  ['whyTheydBuy', "Why They'd Buy"], ['website', 'Website'], ['email', 'Email'], ['phone', 'Phone'], ['priority', 'Priority'],
  ['template', 'Template'], ['emailStatus', 'Email Status'], ['engagement', 'Delivered / Opened / Clicked'], ['lastEmailedAt', 'Last Emailed'], ['followUpAt', 'Follow-up'], ['id', 'ID'],
];
const LTR = new Set(['website', 'email', 'phone']);
const TEXT = ['organization', 'country', 'segment', 'productFit', 'whyTheydBuy', 'website', 'email', 'phone', 'priority', 'emailStatus'];
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
  const f = { country: $('#f-country').value, segment: $('#f-segment').value, productFit: $('#f-fit').value, priority: $('#f-priority').value };
  const tpl = $('#f-template').value, eng = $('#f-eng').value;
  const rows = leads.filter((l) => {
    for (const k in f) if (f[k] && l[k] !== f[k]) return false;
    if (tpl === 'none' && l.templateId) return false;
    if (tpl && tpl !== 'none' && String(l.templateId) !== tpl) return false;
    if (eng === 'sent' && l.emailStatus !== 'sent') return false;
    if (eng === 'opened' && !l.openedAt) return false;
    if (eng === 'clicked' && !l.clickedAt) return false;
    if (eng === 'unopened' && !(l.emailStatus === 'sent' && !l.openedAt)) return false;
    if (eng === 'failed' && !['failed', 'bounced'].includes(l.emailStatus)) return false;
    if (eng === 'replied' && !l.repliedAt) return false;
    if (eng === 'followup' && !(l.followUpAt && new Date(l.followUpAt) <= new Date())) return false;
    return !q || TEXT.some((k) => (l[k] || '').toLowerCase().includes(q));
  });
  const val = (l) => (sortKey === 'template' ? l.template?.name : sortKey === 'engagement' ? engScore(l) : l[sortKey]);
  return rows.sort((a, b) => {
    const x = val(a) ?? '', y = val(b) ?? '';
    if (x === y) return 0;
    if (x === '') return 1;
    if (y === '') return -1; // empty values always last
    return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y), 'en', { numeric: true })) * sortDir;
  });
}

function engagement(l) {
  const dot = (on, ico, title) => `<span class="eg ${on ? 'on' : ''}" title="${esc(title)}">${ico}</span>`;
  return `<span class="egs">${dot(l.deliveredAt, '✓', l.deliveredAt ? `Delivered ${fmt(l.deliveredAt)}` : 'Not delivered yet')}`
    + `${dot(l.openedAt, '👁', l.openedAt ? `Opened ${fmt(l.openedAt)} (${l.openCount}x)` : 'Not opened')}`
    + `${dot(l.clickedAt, '↗', l.clickedAt ? `Clicked ${fmt(l.clickedAt)} (${l.clickCount}x) ${l.lastClickLink || ''}` : 'No link clicked')}</span>`
    + `${l.openCount > 1 ? ` <span class="muted">${l.openCount}</span>` : ''}`;
}

function cell(l, k) {
  const v = l[k];
  if (k === 'engagement') return l.emailStatus === 'not_sent' ? '<span class="muted-cell">—</span>' : engagement(l);
  if (k === 'template') return l.template ? `<span class="st">${esc(l.template.name)}</span>` : '<span class="muted-cell">—</span>';
  if (v == null || v === '') return '<span class="muted-cell">—</span>';
  if (k === 'organization') return `<a href="#" data-card="${l.id}" style="font-weight:600" onclick="return false">${esc(v)}</a>${l.repliedAt ? ' <span class="st sent" title="Replied">↩</span>' : ''}`;
  if (k === 'followUpAt') { const due = new Date(v) <= new Date(); return `<span class="st ${due ? 'failed' : ''}" title="${due ? 'Follow-up due' : 'Follow-up'}">${esc(new Date(v).toISOString().slice(0, 10))}</span>`; }
  if (k === 'priority') return `<span class="pb ${esc(v)}">${esc(v)}</span>`;
  if (k === 'website') return `<a href="${esc(v)}" target="_blank" rel="noopener noreferrer">${esc(v.replace(/^https?:\/\/(www\.)?/, ''))}</a>`;
  if (k === 'email') return `<a href="mailto:${esc(v)}">${esc(v)}</a>`;
  if (k === 'phone') return `<a href="tel:${esc(v.replace(/[^\d+]/g, ''))}">${esc(v)}</a>`;
  if (k === 'emailStatus') return `<span class="st ${esc(v)}" ${l.lastError ? `title="${esc(l.lastError)}"` : ''}>${esc(v)}</span>`;
  if (k === 'lastEmailedAt') return esc(fmt(v));
  return esc(v);
}

function render() {
  const rows = filtered();
  $('#tbl thead').innerHTML = `<tr><th><input type="checkbox" id="chk-page" title="בחר את המוצגים"></th><th></th>${COLS.map(([k, h]) =>
    `<th data-k="${k}" class="${LTR.has(k) ? 'ltr' : ''}">${h}${sortKey === k ? (sortDir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr>`;
  $('#tbl tbody').innerHTML = rows.map((l) => `<tr>
    <td><input type="checkbox" class="rc" data-id="${l.id}" ${selected.has(l.id) ? 'checked' : ''} ${l.email ? '' : 'disabled title="אין אימייל"'}></td>
    <td><button class="btn sm" data-edit="${l.id}" title="ערוך ליד">✎</button></td>
    ${COLS.map(([k]) => `<td class="${LTR.has(k) ? 'ltr' : ''} ${k === 'whyTheydBuy' ? 'wide' : ''}">${cell(l, k)}</td>`).join('')}</tr>`).join('')
    || `<tr><td colspan="${COLS.length + 2}" class="muted">אין תוצאות</td></tr>`;
  $('#count').textContent = `${rows.length} / ${leads.length}`;
  $('#sel-n').textContent = selected.size;
  $('#send').disabled = !selected.size;
  $('#attach').disabled = !selected.size;
}

function fillFilters() {
  const opts = (k) => [...new Set(leads.map((l) => l[k]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  for (const [id, k, label] of [['#f-country', 'country', 'Country'], ['#f-segment', 'segment', 'Segment']]) {
    const cur = $(id).value;
    $(id).innerHTML = `<option value="">${label}: all</option>` + opts(k).map((o) => `<option>${esc(o)}</option>`).join('');
    $(id).value = cur;
  }
  const cur = $('#f-template').value;
  $('#f-template').innerHTML = '<option value="">Template: all</option><option value="none">No template</option>'
    + templates.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  $('#f-template').value = cur;
}

async function load() {
  [leads, templates] = await Promise.all([api('/leads'), api('/templates')]);
  fillFilters();
  for (const id of [...selected]) { const l = leads.find((x) => x.id === id); if (!l || !l.email) selected.delete(id); }
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
    dlgOpen(`<h3 style="margin-top:0">Email templates</h3>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
        ${templates.map((t) => `<button class="btn sm ${cur && cur.id === t.id ? 'primary' : ''}" data-tid="${t.id}">${esc(t.name)}</button>`).join('')}
        <button class="btn sm ${cur ? '' : 'primary'}" data-tid="new">+ New template</button>
      </div>
      <label>Name<input id="m-name" style="width:100%" value="${esc(cur ? cur.name : '')}" placeholder="e.g. Intro + YouTube demo"></label>
      <label>Subject<input id="m-sub" dir="ltr" style="width:100%" value="${esc(cur ? cur.subject : DEFAULT_SUBJECT)}"></label>
      <label>Body<textarea id="m-body" dir="ltr" rows="11">${esc(cur ? cur.body : DEFAULT_BODY)}</textarea></label>
      <div class="vars">
        <button type="button" class="btn sm" id="m-yt">▶ Add YouTube video</button>
        <button type="button" class="btn sm" id="m-link">🔗 Add link</button>
        ${variables.map((v) => `<button type="button" class="btn sm" data-v="${esc(v)}">{{${esc(v)}}}</button>`).join('')}
      </div>
      <div class="muted">YouTube נכנס כתמונה ממוזערת שלחיצה עליה פותחת את הסרטון. הקלקה נספרת בעמודת Clicked.</div>
      <div class="prev"><div><b>Subject:</b> <span id="p-sub" dir="ltr"></span></div><hr><div id="p-body"></div><div id="p-warn" class="warn"></div></div>
      <div style="display:flex;gap:8px;margin-top:12px;align-items:center">
        ${cur ? '<button class="btn danger" id="m-del">Delete</button>' : ''}
        <span style="flex:1"></span>
        <button class="btn ghost" id="m-close">Close</button>
        <button class="btn primary" id="m-save">Save</button>
      </div>`);
    let last = $('#m-body');
    $('#m-sub').onfocus = () => { last = $('#m-sub'); };
    $('#m-body').onfocus = () => { last = $('#m-body'); };
    let timer;
    const preview = async () => {
      try {
        const p = await api('/preview', { method: 'POST', body: { subject: $('#m-sub').value, body: $('#m-body').value } });
        $('#p-sub').textContent = p.subject; $('#p-body').innerHTML = p.html;
        $('#p-warn').textContent = p.unknown.length ? `Unknown variables: ${p.unknown.map((u) => `{{${u}}}`).join(', ')}` : '';
      } catch (e) { $('#p-warn').textContent = e.message; }
    };
    const refresh = () => { clearTimeout(timer); timer = setTimeout(preview, 250); };
    $('#m-sub').oninput = refresh; $('#m-body').oninput = refresh;
    document.querySelectorAll('#dlg-box [data-v]').forEach((b) => {
      b.onmousedown = (e) => e.preventDefault();
      b.onclick = () => { insertAt(last, `{{${b.dataset.v}}}`); refresh(); };
    });
    $('#m-yt').onclick = () => {
      const u = prompt('YouTube link (https://youtu.be/... or https://www.youtube.com/watch?v=...)');
      if (!u) return;
      if (!/^https?:\/\/(www\.)?(youtu\.be\/|youtube\.com\/)/i.test(u.trim())) return toast('לא קישור YouTube תקין', true);
      insertAt($('#m-body'), `\n[video:${u.trim()}]\n`); refresh();
    };
    $('#m-link').onclick = () => {
      const u = prompt('Link URL (https://...)');
      if (!u || !/^https?:\/\//i.test(u.trim())) return;
      const t = prompt('Link text', 'Learn more') || u;
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
        await load(); cur = templates.find((t) => t.id === saved.id); toast('Template saved'); draw();
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
  dlgOpen(`<h3 style="margin-top:0">Attach template · ${selected.size} leads</h3>
    <label>Template<select id="a-tpl" style="width:100%"><option value="">— none (detach) —</option>${tplOptions(0)}</select></label>
    <div style="display:flex;gap:8px;margin-top:12px"><span style="flex:1"></span>
    <button class="btn ghost" id="a-cancel">Cancel</button><button class="btn primary" id="a-ok">Attach</button></div>`);
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
  const ids = [...selected];
  const first = leads.find((l) => l.id === ids[0]);
  const common = leads.filter((l) => selected.has(l.id)).map((l) => l.templateId);
  const pre = common.every((t) => t === common[0]) && common[0] ? common[0] : templates[0].id;
  dlgOpen(`<h3 style="margin-top:0">Send email · ${ids.length} נבחרו</h3>
    ${emailConfigured ? '' : '<p class="warn">שליחה לא מוגדרת בשרת. תצוגה מקדימה זמינה, שליחה תיכשל עם הודעת הגדרה.</p>'}
    <label>Template<select id="s-tpl" style="width:100%">${tplOptions(pre)}</select></label>
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
['#q', '#f-country', '#f-segment', '#f-fit', '#f-priority', '#f-template', '#f-eng'].forEach((s) => { $(s).oninput = render; });
$('#reset').onclick = () => { ['#q', '#f-country', '#f-segment', '#f-fit', '#f-priority', '#f-template', '#f-eng'].forEach((s) => { $(s).value = ''; }); render(); };
$('#sel-all').onclick = () => { filtered().filter((l) => l.email).forEach((l) => selected.add(l.id)); render(); };
$('#sel-none').onclick = () => { selected.clear(); render(); };
$('#send').onclick = openSend;
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
// ---------- Customer card ----------
const ACT = {
  sent: ['✉', 'Email sent'], delivered: ['✓', 'Delivered'], opened: ['👁', 'Opened'], clicked: ['↗', 'Clicked a link'],
  bounced: ['⚠', 'Bounced'], failed: ['⚠', 'Send failed'], replied: ['↩', 'Replied'], template: ['▤', 'Template'],
  edited: ['✎', 'Lead edited'], email_changed: ['✎', 'Email changed'], follow_up: ['⏰', 'Follow-up'], note: ['📝', 'Note'],
};
async function openCard(id) {
  const l = leads.find((x) => x.id === id);
  if (!l) return;
  let acts = [];
  try { acts = await api(`/leads/${id}/activities`); } catch (e) { toast(e.message, true); }
  const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
  const row = ([h, v]) => (v ? `<div style="display:flex;gap:8px"><span class="muted" style="min-width:110px">${h}</span><span dir="ltr">${esc(v)}</span></div>` : '');
  dlgOpen(`<div style="display:flex;justify-content:space-between;align-items:start;gap:8px">
      <h3 style="margin:0">${esc(l.organization)} ${l.priority ? `<span class="pb ${esc(l.priority)}">${esc(l.priority)}</span>` : ''}</h3>
      <div><button class="btn sm" id="cd-edit">✎ Edit</button> <button class="btn sm" id="cd-close">✕</button></div></div>
    <div style="margin:8px 0;display:grid;gap:3px;font-size:13px">
      ${[['Country', l.country], ['Segment', l.segment], ['Product Fit', l.productFit], ['Website', l.website], ['Email', l.email], ['Phone', l.phone],
        ["Why They'd Buy", l.whyTheydBuy], ['Template', l.template && l.template.name], ['Email status', l.emailStatus],
        ['Last emailed', fmt(l.lastEmailedAt)], ['Replied', fmt(l.repliedAt)]].map(row).join('')}
    </div>
    <div class="toolbar wrap" style="margin:10px 0">
      <label style="margin:0">Follow-up date <input type="date" id="cd-fu" value="${day(l.followUpAt)}"></label>
      <button class="btn sm" id="cd-fu-save">Save date</button>
      <button class="btn sm" id="cd-fu-clear">Clear</button>
    </div>
    <label>Add a note (call, meeting, reply, anything)
      <textarea id="cd-note" rows="2" dir="ltr" style="width:100%"></textarea></label>
    <div class="toolbar" style="margin:6px 0 12px"><button class="btn primary sm" id="cd-note-add">Add note</button></div>
    <h4 style="margin:0 0 6px">Activity</h4>
    <div id="cd-acts" style="max-height:260px;overflow:auto;border:1px solid var(--line);border-radius:8px">
      ${acts.map((a) => { const [ico, lab] = ACT[a.type] || ['•', a.type];
        return `<div style="padding:6px 10px;border-bottom:1px solid var(--line);font-size:13px"><span class="muted" style="font-size:12px">${esc(fmt(a.createdAt))}</span>
          <b>${ico} ${lab}</b>${a.detail ? `<div dir="ltr" style="white-space:pre-wrap;color:#444">${esc(a.detail)}</div>` : ''}</div>`; }).join('')
        || '<div class="muted" style="padding:10px">No activity yet</div>'}
    </div>`);
  $('#cd-close').onclick = dlgClose;
  $('#cd-edit').onclick = () => editLead(id);
  const saveFu = async (v) => { try { await api(`/leads/${id}`, { method: 'PUT', body: { followUpAt: v } }); await load(); toast('Saved'); openCard(id); } catch (e) { toast(e.message, true); } };
  $('#cd-fu-save').onclick = () => saveFu($('#cd-fu').value || null);
  $('#cd-fu-clear').onclick = () => saveFu(null);
  $('#cd-note-add').onclick = async () => {
    const detail = $('#cd-note').value.trim();
    if (!detail) return;
    try { await api(`/leads/${id}/activities`, { method: 'POST', body: { detail } }); openCard(id); } catch (e) { toast(e.message, true); }
  };
}

// ---------- Edit a lead ----------
const EDIT_FIELDS = [['organization', 'Organization'], ['country', 'Country'], ['segment', 'Segment'], ['productFit', 'Product Fit'],
  ['whyTheydBuy', "Why They'd Buy"], ['website', 'Website'], ['email', 'Email'], ['phone', 'Phone'], ['priority', 'Priority']];
function editLead(id) {
  const l = leads.find((x) => x.id === id);
  if (!l) return;
  dlgOpen(`<h3 style="margin-top:0">Edit lead</h3>
    ${EDIT_FIELDS.map(([k, h]) => `<label>${h}${k === 'whyTheydBuy'
      ? `<textarea data-f="${k}" rows="3" dir="ltr" style="width:100%">${esc(l[k])}</textarea>`
      : `<input data-f="${k}" value="${esc(l[k])}" dir="ltr" style="width:100%">`}</label>`).join('')}
    <p class="muted" style="font-size:12px;margin:8px 0 0">Changing the email resets this lead's send status so it can be mailed again.</p>
    <div class="toolbar" style="margin-top:12px"><button class="btn primary" id="le-save">Save</button><button class="btn" id="le-cancel">Cancel</button></div>`);
  $('#le-cancel').onclick = dlgClose;
  $('#le-save').onclick = async () => {
    const body = {};
    document.querySelectorAll('#dlg-box [data-f]').forEach((el) => { body[el.dataset.f] = el.value; });
    try { await api(`/leads/${id}`, { method: 'PUT', body }); dlgClose(); await load(); toast('Lead saved'); } catch (e) { toast(e.message, true); }
  };
}

$('#tbl').addEventListener('click', (e) => {
  const th = e.target.closest('th[data-k]');
  if (th) { sortDir = sortKey === th.dataset.k ? -sortDir : 1; sortKey = th.dataset.k; render(); return; }
  if (e.target.id === 'chk-page') { filtered().filter((l) => l.email).forEach((l) => (e.target.checked ? selected.add(l.id) : selected.delete(l.id))); render(); return; }
  const cb = e.target.closest('[data-card]');
  if (cb) { openCard(+cb.dataset.card); return; }
  const eb = e.target.closest('[data-edit]');
  if (eb) { editLead(+eb.dataset.edit); return; }
  if (e.target.classList.contains('rc')) {
    const id = +e.target.dataset.id;
    if (e.target.checked) selected.add(id); else selected.delete(id);
    $('#sel-n').textContent = selected.size; $('#send').disabled = !selected.size; $('#attach').disabled = !selected.size;
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
})().catch((e) => toast(e.message, true));
