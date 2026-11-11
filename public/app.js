/* CRM dashboard — vanilla JS, no build step. */
const STAGE_LABELS = { NEW: 'חדש', CONTACTED: 'נוצר קשר', ENGAGED: 'מעורב', QUALIFIED: 'מתאים', PROPOSAL: 'הצעה', WON: 'נסגר ✓', LOST: 'אבוד' };
const STAGES = Object.keys(STAGE_LABELS);
const ACT = {
  CREATED: ['＋', 'ליד נוצר'], NOTE: ['✎', 'הערה'], STAGE_CHANGED: ['→', 'שינוי שלב'],
  EMAIL_QUEUED: ['⧗', 'מייל בתור'], EMAIL_SENT: ['✉', 'מייל נשלח'], EMAIL_DELIVERED: ['✓', 'נמסר'],
  EMAIL_OPENED: ['👁', 'נפתח'], EMAIL_CLICKED: ['↗', 'לחיצה על קישור'], EMAIL_REPLIED: ['↩', 'השיב'],
  EMAIL_BOUNCED: ['✕', 'חזר (bounce)'], EMAIL_COMPLAINED: ['⚠', 'סומן כספאם'], EMAIL_FAILED: ['✕', 'שליחה נכשלה'],
  MANUAL_EMAIL_OUT: ['✉', 'מייל שנשלח (ידני)'], REPLY_IN: ['↩', 'תשובה התקבלה'], SMS_OUT: ['💬', 'SMS נשלח'], SMS_IN: ['💬', 'SMS התקבל'],
  CALL: ['☎', 'שיחה'], MEETING: ['🤝', 'פגישה'],
  UNSUBSCRIBED: ['⊘', 'הסיר עצמו מהתפוצה'], SEQUENCE_ENROLLED: ['▶', 'נוסף לרצף'], STALE_FLAGGED: ['⏸', 'סומן כרדום'],
};
const KINDS = { EMAIL_OUT: 'מייל שנשלחתי (ידני)', EMAIL_IN: 'תשובה במייל שהתקבלה', SMS_OUT: 'SMS שנשלח', SMS_IN: 'SMS שהתקבל', CALL: 'שיחה', MEETING: 'פגישה' };
const REASONS = { 'auto:manual_outreach': 'אוטומטי · מייל ידני', manual: 'ידני', 'auto:email_sent': 'אוטומטי · נשלח מייל', 'auto:click': 'אוטומטי · לחיצה', 'auto:reply': 'אוטומטי · תשובה' };

let csrf = '';
let meta = { stages: STAGES, sources: [], tags: [] };
let sequences = [];
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (d) => (d ? new Date(d).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : '');
const dayStr = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const fuState = (l) => (!l.nextFollowUpAt ? null : new Date(l.nextFollowUpAt) <= new Date() ? 'over' : 'ok');
const ago = (d) => {
  const m = Math.round((Date.now() - new Date(d)) / 60000);
  if (m < 60) return `לפני ${m} ד׳`;
  const h = Math.round(m / 60);
  if (h < 24) return `לפני ${h} ש׳`;
  return `לפני ${Math.round(h / 24)} ימים`;
};

async function api(path, opts = {}) {
  const isForm = opts.body instanceof FormData;
  const r = await fetch(`/api${path}`, {
    ...opts,
    headers: { ...(isForm ? {} : { 'content-type': 'application/json' }), 'x-csrf-token': csrf, ...(opts.headers || {}) },
    body: isForm ? opts.body : opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (r.status === 401) { location.href = '/login'; throw new Error('unauthenticated'); }
  if (r.status === 204) return null;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show${err ? ' err' : ''}`;
  clearTimeout(t._t);
  t._t = setTimeout(() => { t.className = 'toast'; }, 2600);
}
const ERR = {
  message_not_editable: 'ההודעה כבר נשלחה או בוטלה', subject_and_body_required: 'נושא ותוכן חובה',
  duplicate_email: 'אימייל כבר קיים במערכת', invalid_email: 'אימייל לא תקין', lead_unsubscribed: 'הליד הסיר עצמו מהתפוצה',
  lead_bounced: 'כתובת המייל חוזרת (bounce)', lead_not_emailable: 'לא ניתן לשלוח לליד הזה', already_enrolled: 'הליד כבר ברצף הזה',
  sequence_has_active_enrollments: 'יש לידים פעילים ברצף — לא ניתן לערוך צעדים', delays_must_be_ascending: 'ימי ההמתנה חייבים להיות בסדר עולה',
};
const fail = (e) => toast(ERR[e.message] || `שגיאה: ${e.message}`, true);

function flagsHtml(l) {
  const f = [];
  if (l.unsubscribed) f.push('<span class="flag bad">הוסר</span>');
  if (l.bounced) f.push('<span class="flag bad">bounce</span>');
  if (l.replied) f.push('<span class="flag good">השיב</span>');
  if (l.stale) f.push('<span class="flag warn">רדום</span>');
  (l.tags || []).slice(0, 3).forEach((t) => f.push(`<span class="flag">${esc(t)}</span>`));
  return f.length ? `<div class="flags">${f.join('')}</div>` : '';
}

// ---------------- Board ----------------
async function renderBoard() {
  const q = $('#board-q').value.trim();
  const rows = await api(`/leads${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  const board = $('#board');
  const open = new Set([...board.querySelectorAll('details[open]')].map((d) => d.dataset.stage));
  const first = !board.children.length;
  board.innerHTML = STAGES.map((s) => {
    const items = rows.filter((l) => l.stage === s);
    const isOpen = first ? !['WON', 'LOST'].includes(s) : open.has(s);
    return `<details class="stage-group" data-stage="${s}" style="--c:var(--s-${s})" ${isOpen ? 'open' : ''}>
      <summary><span class="dot"></span><b>${STAGE_LABELS[s]}</b> <span class="count">${items.length}</span></summary>
      ${items.length ? `<div class="lrows">${items.map((l) => `
        <div class="lrow" data-id="${l.id}">
          <span class="c-name"><b>${esc(l.name)}</b></span>
          <span class="c-co muted">${esc(l.company || l.email)}</span>
          <span class="c-fu ${fuState(l) === 'over' ? 'over' : 'muted'}">${l.nextFollowUpAt ? `${esc(l.nextAction || 'מעקב')} · ${dateHe(l.nextFollowUpAt)}` : ''}</span>
          <span class="c-last muted" title="${fmt(l.lastActivityAt)}">${ago(l.lastActivityAt)}</span>
          <span class="c-flags">${flagsHtml(l)}</span>
          <button class="btn sm ghost danger c-del" data-del="${l.id}" data-name="${esc(l.name)}" title="מחיקה" aria-label="מחיקה">🗑</button>
          <select class="c-stage" aria-label="שלב">${STAGES.map((st) => `<option value="${st}" ${st === l.stage ? 'selected' : ''}>${STAGE_LABELS[st]}</option>`).join('')}</select>
        </div>`).join('')}</div>` : '<p class="muted empty">אין לידים בשלב</p>'}
    </details>`;
  }).join('');

  board.querySelectorAll('.lrow').forEach((r) => r.addEventListener('click', (e) => {
    if (e.target.closest('select')) return;
    const d = e.target.closest('[data-del]');
    if (d) return confirmDelete([+d.dataset.del], d.dataset.name);
    openLead(+r.dataset.id);
  }));
  board.querySelectorAll('.c-stage').forEach((sel) => sel.addEventListener('change', async () => {
    const id = sel.closest('.lrow').dataset.id;
    try {
      await api(`/leads/${id}/stage`, { method: 'POST', body: { stage: sel.value } });
      toast(`הועבר ל"${STAGE_LABELS[sel.value]}"`);
    } catch (err) { fail(err); }
    renderBoard();
  }));
}

// ---------------- Leads table ----------------
async function renderLeads() {
  const p = new URLSearchParams();
  const v = (id) => $(id).value.trim();
  if (v('#f-q')) p.set('q', v('#f-q'));
  if (v('#f-stage')) p.set('stage', v('#f-stage'));
  if (v('#f-tag')) p.set('tag', v('#f-tag'));
  if (v('#f-source')) p.set('source', v('#f-source'));
  if (v('#f-inactive')) p.set('inactiveDays', v('#f-inactive'));
  if (v('#f-priority')) p.set('priority', v('#f-priority'));
  if (v('#f-country')) p.set('country', v('#f-country'));
  if (v('#f-activity')) p.set('activity', v('#f-activity'));
  if (v('#f-segment')) p.set('segment', v('#f-segment'));
  if ($('#f-stale').checked) p.set('stale', 'true');
  const rows = await api(`/leads?${p}`);
  const host = (u) => String(u || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '');
  $('#leads-body').innerHTML = rows.length ? rows.map((l) => `
    <tr data-id="${l.id}" data-name="${esc(l.name)}">
      <td><input type="checkbox" class="sel" value="${l.id}"></td>
      <td class="c-org"><b>${esc(l.company || l.name)}</b>${l.company && l.company !== l.name ? `<div class="muted">${esc(l.name)}</div>` : ''}</td>
      <td>${esc(l.country)}</td>
      <td>${esc(l.segment)}</td>
      <td>${(l.tags || []).map((t) => `<span class="flag">${esc(t)}</span>`).join(' ')}</td>
      <td>${l.website ? `<a href="${esc(/^https?:/i.test(l.website) ? l.website : `https://${l.website}`)}" target="_blank" rel="noopener" dir="ltr">${esc(host(l.website))}</a>` : ''}</td>
      <td class="c-contact" dir="ltr"><div>${esc(l.email)}</div>${l.phone ? `<div class="muted">${esc(l.phone)}</div>` : ''}</td>
      <td class="c-why" title="${esc(l.notes)}">${esc(l.notes)}</td>
      <td><span class="pill" style="--c:var(--s-${l.stage})">${STAGE_LABELS[l.stage]}</span></td>
      <td title="${fmt(l.lastActivityAt)}">${ago(l.lastActivityAt)}${l.stale ? ' <span class="flag warn">רדום</span>' : ''}</td>
      <td><button class="btn sm ghost danger" data-del="${l.id}" data-name="${esc(l.name)}" title="מחיקה" aria-label="מחיקה">🗑</button></td>
    </tr>`).join('') : '<tr><td colspan="12" class="muted">אין לידים תואמים</td></tr>';
  $('#leads-body').querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.matches('input')) return;
    const d = e.target.closest('[data-del]');
    if (d) return confirmDelete([+d.dataset.del], d.dataset.name);
    openLead(+tr.dataset.id);
  }));
}

// Multi-select dropdown: <details class="ms">; .value is the checked values joined by commas.
function msInit(sel) {
  const el = $(sel);
  Object.defineProperty(el, 'value', { get: () => [...el.querySelectorAll('input:checked')].map((c) => c.value).join(','), set: () => {} });
  el.addEventListener('change', () => {
    const n = el.querySelectorAll('input:checked').length;
    el.querySelector('summary').textContent = n ? `${el.dataset.all.replace(/^כל /, '')} (${n})` : el.dataset.all;
    el.classList.toggle('on', n > 0);
  });
}
function fillMs(sel, items) {
  const el = $(sel);
  const cur = new Set(el.value.split(',').filter(Boolean));
  el.querySelector('.ms-list').innerHTML = items.map((i) => `<label><input type="checkbox" value="${esc(i)}" ${cur.has(i) ? 'checked' : ''}> ${esc(i)}</label>`).join('') || '<span class="muted">אין ערכים</span>';
}
['#f-tag', '#f-segment', '#f-country'].forEach(msInit);
document.addEventListener('click', (e) => document.querySelectorAll('details.ms[open]').forEach((d) => { if (!d.contains(e.target)) d.removeAttribute('open'); }));

async function loadMeta() {
  meta = await api('/leads/meta');
  const fill = (sel, items, label = (x) => x) => {
    const cur = $(sel).value;
    $(sel).innerHTML = $(sel).options[0].outerHTML + items.map((i) => `<option value="${esc(i)}">${esc(label(i))}</option>`).join('');
    $(sel).value = cur;
  };
  fill('#f-stage', STAGES, (s) => STAGE_LABELS[s]);
  fillMs('#f-tag', meta.tags);
  fill('#f-source', meta.sources);
  fillMs('#f-country', meta.countries || []);
  fillMs('#f-segment', meta.segments || []);
  sequences = await api('/sequences');
  fill('#bulk-seq', sequences.map((s) => String(s.id)), (id) => sequences.find((s) => String(s.id) === id).name);
}

// ---------------- Lead drawer ----------------
// ---------------- Routing ----------------
// The address is #/<view> or #/<view>/lead/<id>, so Back/Forward, reload and bookmarks all work.
// Opening a view or a lead adds a history entry; closing the drawer replaces it.
let view = 'board';
let drawerLead = null;
function setHash(h, replace) {
  if (location.hash === h) return;
  if (replace) history.replaceState(null, '', h); else location.hash = h;
}

function closeDrawer() {
  $('#drawer').classList.add('hidden'); $('#scrim').classList.add('hidden');
  if (drawerLead !== null) { drawerLead = null; setHash(`#/${view}`, true); }
}

const NEXT_ACTIONS = ['שיחת טלפון', 'שליחת מייל', 'פגישה', 'לשלוח הצעה', 'מעקב', 'להשיב'];
const NEXT_ICON = (a) => (/טלפון|שיחה/.test(a || '') ? '☎' : /פגישה/.test(a || '') ? '🤝' : /מייל|להשיב|הצעה/.test(a || '') ? '✉' : '⏰');
const isCallAction = (a) => /טלפון|שיחה/.test(a || '');

async function openLead(id, replace) {
  const l = await api(`/leads/${id}`);
  drawerLead = id;
  setHash(`#/${view}/lead/${id}`, replace);
  const actText = (a) => {
    const d = a.data || {};
    if (a.type === 'STAGE_CHANGED') return `${STAGE_LABELS[d.from]} ← ${STAGE_LABELS[d.to]} <span class="muted">(${REASONS[d.reason] || esc(d.reason)})</span>`;
    if (a.type === 'NOTE') return esc(d.text);
    if (d.manual) return `${d.subject ? `<span dir="auto" style="unicode-bidi:plaintext">"${esc(d.subject)}"</span>` : ''}${d.body ? `<div dir="auto" class="body ${['REPLY_IN', 'SMS_IN'].includes(a.type) ? 'in' : ''}">${esc(d.body)}</div>` : ''}`;
    if (d.subject) return `"${esc(d.subject)}"`;
    if (d.name) return esc(d.name);
    if (d.link) return esc(d.link);
    if (d.error) return esc(d.error);
    return '';
  };
  const enr = l.enrollments.map((e) => `<div>${esc(e.sequence.name)} — ${{ ACTIVE: 'פעיל', COMPLETED: 'הושלם', STOPPED: 'נעצר' }[e.status]}${e.stopReason ? ` (${esc(e.stopReason)})` : ''}${e.status === 'ACTIVE' && e.nextRunAt ? ` · הבא: ${fmt(e.nextRunAt)}` : ''}</div>`).join('') || '<div class="muted">לא ברצף</div>';
  const emailable = !l.unsubscribed && !l.bounced;

  $('#drawer-body').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:start;gap:8px">
      <div><h2>${esc(l.name)}</h2><div class="muted">${esc(l.email)}</div>${flagsHtml(l)}</div>
      <button class="btn ghost" id="d-close" aria-label="סגור">✕</button>
    </div>
    <div class="actions">
      <button class="btn primary" id="d-email" ${emailable ? '' : 'disabled'}>✉ כתוב מייל</button>
      <select id="d-seq" ${emailable ? '' : 'disabled'}><option value="">הוסף לרצף…</option>${sequences.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
      <button class="btn" id="d-replied">↩ סמן שהשיב</button>
      <button class="btn" id="d-unenroll">עצור רצפים</button>
      <button class="btn danger" id="d-del">מחיקה</button>
    </div>
    <section class="nextstep"><h4>הצעד הבא</h4>
      <div class="ns-state ${fuState(l) === 'over' ? 'over' : ''}">${l.nextFollowUpAt ? `${NEXT_ICON(l.nextAction)} <b>${esc(l.nextAction || 'מעקב')}</b> · ${dateHe(l.nextFollowUpAt)}${fuState(l) === 'over' ? ' · באיחור' : ''}<span class="muted"> · מופיע בטאב "היום"</span>` : '<span class="muted">אין צעד מתוכנן</span>'}</div>
      <form id="d-next">
        <div class="logrow">
          <select name="stage" aria-label="שלב">${STAGES.map((s) => `<option value="${s}" ${s === l.stage ? 'selected' : ''}>${STAGE_LABELS[s]}</option>`).join('')}</select>
          <input name="nextAction" list="ns-opts" value="${esc(l.nextAction)}" placeholder="פעולה: שיחת טלפון, פגישה…" autocomplete="off">
          <datalist id="ns-opts">${NEXT_ACTIONS.map((a) => `<option value="${a}">`).join('')}</datalist>
        </div>
        <div class="logrow">
          <input name="nextFollowUpAt" type="date" value="${dayStr(l.nextFollowUpAt)}" aria-label="תאריך">
          <span class="chips"><button type="button" class="btn sm" data-d="0">היום</button><button type="button" class="btn sm" data-d="1">מחר</button><button type="button" class="btn sm" data-d="3">+3</button><button type="button" class="btn sm" data-d="7">שבוע</button></span>
        </div>
        <div class="logrow"><span class="muted">עדכון שלב, פעולה ותאריך מופיע מיד ב"היום" ובכרטיס.</span><button class="btn primary">שמירה</button></div>
      </form>
    </section>
    <section><h4>ציר זמן</h4><ul class="timeline">${l.activities.map((a) => `
      <li><span class="ic">${(ACT[a.type] || ['•'])[0]}</span><div><b>${(ACT[a.type] || [, a.type])[1]}</b> ${actText(a)}<time>${fmt(a.createdAt)}</time></div></li>`).join('')}</ul></section>
    <section>
      <h4>תיעוד אינטראקציה</h4>
      <form id="d-log" style="display:flex;flex-direction:column;gap:6px">
        <div class="logrow"><select name="kind" required><option value="">בחר סוג…</option>${Object.entries(KINDS).map(([k, t]) => `<option value="${k}">${t}</option>`).join('')}</select><input name="at" type="date" value="${dayStr(new Date())}"></div>
        <input name="subject" placeholder="נושא (אופציונלי)">
        <textarea name="body" rows="4" placeholder="הדבק כאן את תוכן המייל / ההודעה / סיכום השיחה"></textarea>
        <div class="logrow"><input name="followUpDays" type="number" min="0" placeholder="מעקב בעוד X ימים (ברירת מחדל לפי הסוג)"><button class="btn primary">תעד</button></div>
      </form>
    </section>
    <section>
      <h4>הוספת הערה</h4>
      <form id="d-note" style="display:flex;gap:8px"><input name="text" placeholder="סיכום שיחה, משימה…" style="flex:1" required><button class="btn">הוסף</button></form>
    </section>
    <section><h4>רצפים</h4>${enr}</section>
    <details class="dd"><summary>פרטי הליד ועריכה</summary>
    <form id="d-form">
      <div class="row">
        <label>שם<input name="name" value="${esc(l.name)}" required></label>
        <label>שלב<select name="stage">${STAGES.map((s) => `<option value="${s}" ${s === l.stage ? 'selected' : ''}>${STAGE_LABELS[s]}</option>`).join('')}</select></label>
        <label>טלפון<input name="phone" value="${esc(l.phone)}" dir="ltr"></label>
        <label>חברה<input name="company" value="${esc(l.company)}"></label>
        <label>מקור<input name="source" value="${esc(l.source)}"></label>
        <label>אחראי<input name="owner" value="${esc(l.owner)}"></label>
        <label>מדינה<input name="country" value="${esc(l.country)}"></label>
        <label>סגמנט<input name="segment" value="${esc(l.segment)}"></label>
        <label>עדיפות<select name="priority"><option value=""></option>${['A', 'B', 'C'].map((x) => `<option ${l.priority === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
        <label>אתר<input name="website" value="${esc(l.website)}" dir="ltr"></label>
        <label>הפעולה הבאה<input name="nextAction" value="${esc(l.nextAction)}" placeholder="למשל: לשלוח הצעה"></label>
        <label>תאריך מעקב<input name="nextFollowUpAt" type="date" value="${dayStr(l.nextFollowUpAt)}"></label>
        <label class="full">תגיות (מופרדות בפסיק)<input name="tags" value="${esc((l.tags || []).join(', '))}"></label>
        <label class="full">הערות<textarea name="notes" rows="2">${esc(l.notes)}</textarea></label>
      </div>
      <div class="actions"><button class="btn primary">שמירה</button></div>
    </form>
    </details>`;

  $('#drawer').classList.remove('hidden');
  $('#drawer').scrollTop = 0; $('#drawer-body').scrollTop = 0;
  $('#scrim').classList.remove('hidden');
  $('#d-close').onclick = closeDrawer;
  const refresh = () => { openLead(id); refreshView(); };

  $('#d-next').onclick = (e) => {
    const b = e.target.closest('[data-d]');
    if (b) $('#d-next [name="nextFollowUpAt"]').value = dayStr(new Date(Date.now() + Number(b.dataset.d) * 86400000));
  };
  $('#d-next').onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    if (fd.nextAction && !fd.nextFollowUpAt) fd.nextFollowUpAt = dayStr(new Date());
    try {
      await api(`/leads/${id}`, { method: 'PATCH', body: fd });
      toast('נשמר');
      refresh();
      if (view !== 'followups') renderFollowups().catch(() => {});
    } catch (err) { fail(err); }
  };
  $('#d-form').onsubmit = async (e) => {
    e.preventDefault();
    try { await api(`/leads/${id}`, { method: 'PATCH', body: Object.fromEntries(new FormData(e.target)) }); toast('נשמר'); refresh(); } catch (err) { fail(err); }
  };
  $('#d-log').onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    if (fd.at) fd.at = `${fd.at}T12:00:00`;
    try { await api(`/leads/${id}/log`, { method: 'POST', body: fd }); toast('תועד'); refresh(); } catch (err) { fail(err); }
  };
  $('#d-note').onsubmit = async (e) => {
    e.preventDefault();
    try { await api(`/leads/${id}/notes`, { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); refresh(); } catch (err) { fail(err); }
  };
  $('#d-replied').onclick = async () => { try { await api(`/leads/${id}/replied`, { method: 'POST' }); toast('סומן — רצפים נעצרו'); refresh(); } catch (err) { fail(err); } };
  $('#d-unenroll').onclick = async () => { try { const r = await api(`/leads/${id}/unenroll`, { method: 'POST' }); toast(`נעצרו ${r.stopped} רצפים`); refresh(); } catch (err) { fail(err); } };
  $('#d-del').onclick = () => confirmDelete([id], l.name);
  $('#d-seq').onchange = async (e) => {
    if (!e.target.value) return;
    try { await api(`/leads/${id}/enroll`, { method: 'POST', body: { sequenceId: +e.target.value } }); toast('נוסף לרצף'); refresh(); } catch (err) { fail(err); e.target.value = ''; }
  };
  $('#d-email').onclick = () => composeModal(l);
}


const INSERT_BAR = (i = '') => `<div class="insrow"><button type="button" class="btn ghost sm" data-ins="link" data-for="${i}">🔗 הוסף קישור</button><button type="button" class="btn ghost sm" data-ins="video" data-for="${i}">▶ הוסף סרטון YouTube</button></div>`;

// Compose an email. With a lead: send to it. Without: ask for the address (creates the lead if new).
function composeModal(lead, prefill = {}) {
  const form = modal(`<h3>${lead ? `מייל ל-${esc(lead.name)}` : 'מייל חדש'}</h3>
    ${lead ? `<input type="hidden" name="leadId" value="${lead.id}">` : `
    <label>אל: בחר ליד מהרשימה או הקלד כתובת חדשה<input name="email" type="text" list="to-opts" dir="ltr" autocomplete="off" required placeholder="התחל להקליד שם, חברה או אימייל"></label>
    <datalist id="to-opts"></datalist>
    <p class="muted" id="to-hint">הנמען יהפוך לליד אחרי השליחה (אם עוד לא קיים), והתשובה שלו תופיע בטאב "דואר".</p>
    <div id="to-new" class="hidden"><label>שם (ליד חדש)<input name="name"></label><label>חברה (ליד חדש)<input name="company"></label></div>`}
    <label>נושא<input name="subject" required></label>
    <label>תוכן — משתנים: {{name}}, {{first_name}}, {{company}}<textarea name="body" rows="9" required></textarea></label>
    ${INSERT_BAR('')}
    <p class="muted">קישור: הדבק כתובת, או השתמש בכפתורים. סרטון YouTube יוצג כתמונה שנפתחת בלחיצה. החתימה נוספת אוטומטית.</p>
    <div class="logrow"><button type="button" class="btn" data-preview="">👁 תצוגה מקדימה</button><button type="button" class="btn" data-test="">✉ שלח לי בדיקה</button></div>`, async (fd) => {
    if (lead) await api(`/leads/${lead.id}/email`, { method: 'POST', body: fd });
    else await api('/compose', { method: 'POST', body: fd });
    toast('המייל בתור ויישלח בדקה הקרובה');
    refreshView();
    if (lead) openLead(lead.id);
  }, 'שליחה');
  if (prefill.subject) form.querySelector('[name="subject"]').value = prefill.subject;
  if (!lead) {
    const dl = form.querySelector('#to-opts');
    const inp = form.querySelector('[name="email"]');
    const hint = form.querySelector('#to-hint');
    const box = form.querySelector('#to-new');
    api('/leads').then((all) => {
      dl.innerHTML = all.map((l) => `<option value="${esc(l.email)}">${esc(l.name)}${l.company ? ` · ${esc(l.company)}` : ''}</option>`).join('');
      const check = () => {
        const v = inp.value.trim().toLowerCase();
        const hit = all.find((l) => l.email.toLowerCase() === v);
        box.classList.toggle('hidden', !!hit || !v.includes('@'));
        hint.textContent = hit ? `ליד קיים: ${hit.name} (${STAGE_LABELS[hit.stage]}). המייל יתועד בכרטיס שלו.` : v.includes('@') ? 'כתובת חדשה. ייווצר ליד חדש אחרי השליחה.' : 'הנמען יהפוך לליד אחרי השליחה (אם עוד לא קיים), והתשובה שלו תופיע בטאב "דואר".';
      };
      inp.addEventListener('input', check);
    }).catch(() => {});
  }
}

// ---------------- Modal helper ----------------
function modal(html, onSubmit, okText = 'שמירה') {
  const dlg = $('#modal');
  const form = $('#modal-form');
  form.innerHTML = `${html}<div class="btns"><button class="btn" value="cancel" formnovalidate>ביטול</button><button class="btn primary" value="ok">${okText}</button></div>`;
  form.onsubmit = async (e) => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    try { await onSubmit(Object.fromEntries(new FormData(form)), form); dlg.close(); } catch (err) { fail(err); }
  };
  form.onclick = async (e) => {
    const ins = e.target.closest('[data-ins]');
    if (ins) {
      e.preventDefault();
      const field = form.querySelector(`[name="${ins.dataset.for === '' ? 'body' : `b${ins.dataset.for}`}"]`);
      const url = prompt(ins.dataset.ins === 'video' ? 'כתובת הסרטון ביוטיוב (למשל https://youtu.be/XXXX):' : 'כתובת הקישור (https://...):');
      if (!url) return;
      let snippet = url;
      if (ins.dataset.ins === 'video') snippet = `[video:${url}]`;
      else { const label = prompt('טקסט הקישור (אפשר להשאיר ריק ולהציג את הכתובת):'); if (label) snippet = `[${label}](${url})`; }
      const a = field.selectionStart ?? field.value.length;
      field.value = `${field.value.slice(0, a)}${snippet}${field.value.slice(field.selectionEnd ?? a)}`;
      field.focus();
      return;
    }
    const pv = e.target.closest('[data-preview]');
    const ts = e.target.closest('[data-test]');
    if (!pv && !ts) return;
    e.preventDefault();
    const i = (pv || ts).dataset.preview ?? (pv || ts).dataset.test;
    const f = new FormData(form);
    const payload = { subject: f.get(i === '' ? 'subject' : `s${i}`), body: f.get(i === '' ? 'body' : `b${i}`), leadId: f.get('leadId') || undefined };
    try {
      if (pv) await showPreview(payload);
      else { const r = await api('/test-email', { method: 'POST', body: payload }); toast(`נשלח לבדיקה אל ${r.sentTo}`); }
    } catch (err) { fail(err); }
  };
  dlg.showModal();
  return form;
}

async function showPreview(payload) {
  const r = await api('/preview', { method: 'POST', body: payload });
  $('#pv-meta').innerHTML = `נושא: <b>${esc(r.subject)}</b>${r.sampleLead ? ' · משתנים מולאו בליד לדוגמה (Fotini Kanat, MG Yachts)' : ''}`;
  $('#pv-frame').srcdoc = r.html;
  $('#preview-dlg').showModal();
}
$('#pv-close').onclick = () => $('#preview-dlg').close();

function newLead() {
  modal(`<h3>ליד חדש</h3>
    <label>שם<input name="name" required></label>
    <label>אימייל<input name="email" type="email" dir="ltr" required></label>
    <label>טלפון<input name="phone" dir="ltr"></label>
    <label>חברה<input name="company"></label>
    <label>מקור<input name="source" list="dl-src"></label>
    <datalist id="dl-src">${meta.sources.map((s) => `<option value="${esc(s)}">`).join('')}</datalist>
    <label>תגיות (מופרדות בפסיק)<input name="tags"></label>`, async (fd) => {
    const l = await api('/leads', { method: 'POST', body: fd });
    toast('ליד נוצר');
    await loadMeta();
    refreshView();
    openLead(l.id);
  });
}

// ---------------- Today (reply / follow up) ----------------
const endOfToday = () => { const d = new Date(); d.setHours(23, 59, 59, 999); return d; };
const dateHe = (d) => new Date(d).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' });

function todayItem(l, group) {
  const last = (l.activities || [])[0];
  const d = (last && last.data) || {};
  const over = new Date(l.nextFollowUpAt) < new Date(new Date().setHours(0, 0, 0, 0));
  const note = last ? `${(ACT[last.type] || [, last.type])[1]} · ${fmt(last.createdAt)}${d.subject ? ` · ${d.subject}` : ''}` : '';
  return `<div class="fu-item ${over ? 'over' : ''}" data-id="${l.id}" data-subject="${esc(d.subject || '')}">
    <span class="c-name"><b>${esc(l.name)}</b><span class="muted">${esc(l.company || l.email)}${l.country ? ` · ${esc(l.country)}` : ''}</span></span>
    <span class="c-stage"><span class="pill" style="--c:var(--s-${l.stage})">${STAGE_LABELS[l.stage]}</span>${l.priority ? ` <span class="flag">${esc(l.priority)}</span>` : ''}</span>
    <span class="c-fu ${over ? 'over' : ''}">${NEXT_ICON(l.nextAction)} ${esc(l.nextAction || 'מעקב')} · ${dateHe(l.nextFollowUpAt)}${over ? ' <span class="flag bad">באיחור</span>' : ''}</span>
    <span class="c-note muted" dir="auto" title="${esc(d.body ? d.body.slice(0, 400) : note)}">${esc(note)}</span>
    <span class="acts">
      ${isCallAction(l.nextAction) ? (l.phone ? `<a class="btn sm primary" href="tel:${esc(l.phone.replace(/[^\d+]/g, ''))}" dir="ltr">☎ ${esc(l.phone)}</a>` : '<button class="btn sm primary" data-a="open" title="אין טלפון בכרטיס">☎ הוסף טלפון</button>') : `<button class="btn sm primary" data-a="reply">${group === 'reply' ? 'השב' : 'מייל'}</button>`}
      <button class="btn sm" data-a="done" title="טופל">✓</button>
      <button class="btn sm" data-a="snooze3" title="דחה 3 ימים">+3</button>
      <button class="btn sm" data-a="snooze7" title="דחה שבוע">+7</button>
      <button class="btn sm ghost danger" data-a="del" data-name="${esc(l.name)}" title="מחיקה" aria-label="מחיקה">🗑</button>
    </span></div>`;
}

async function renderFollowups() {
  const [rows, outbox] = await Promise.all([api('/followups'), api('/outbox').catch(() => [])]);
  const drafts = outbox.filter((m) => m.status === 'DRAFT').length;
  const eod = endOfToday();
  const week = new Date(eod.getTime() + 7 * 86400000);
  const reply = rows.filter((l) => l.replied && l.nextAction === 'להשיב');
  const rest = rows.filter((l) => !reply.includes(l));
  const dueToday = rest.filter((l) => new Date(l.nextFollowUpAt) <= eod);
  const soon = rest.filter((l) => new Date(l.nextFollowUpAt) > eod && new Date(l.nextFollowUpAt) <= week);
  const later = rest.filter((l) => new Date(l.nextFollowUpAt) > week);
  const overdueN = [...reply, ...dueToday].filter((l) => new Date(l.nextFollowUpAt) < new Date(new Date().setHours(0, 0, 0, 0))).length;

  const b = $('#fu-count');
  const urgent = reply.length + dueToday.length + drafts;
  b.textContent = urgent;
  b.classList.toggle('hidden', !urgent);

  const group = (title, items, kind, emptyMsg) => `<div class="fu-group"><h3>${title} <span class="count">${items.length}</span></h3>
    ${items.length ? items.map((l) => todayItem(l, kind)).join('') : `<p class="muted">${emptyMsg}</p>`}</div>`;

  $('#today').innerHTML = `
    <div class="kpis2">
      <div class="k ${reply.length ? 'red' : ''}"><b>${reply.length}</b>להשיב</div>
      <div class="k ${dueToday.length ? 'red' : ''}"><b>${dueToday.length}</b>מעקב להיום</div>
      <div class="k ${overdueN ? 'red' : ''}"><b>${overdueN}</b>באיחור</div>
      <div class="k" data-go="outbox"><b>${drafts}</b>ממתינים לאישור</div>
      <div class="k"><b>${soon.length}</b>ב-7 הימים הקרובים</div>
    </div>
    ${group('להשיב עכשיו', reply, 'reply', 'אין תשובות שממתינות למענה. כשמגיעה תשובה היא תופיע כאן.')}
    ${group('מעקב להיום ובאיחור', dueToday, 'follow', 'אין מעקבים להיום.')}
    ${group('בשבוע הקרוב', soon, 'follow', 'אין מעקבים בשבוע הקרוב.')}
    ${later.length ? group('מאוחר יותר', later, 'follow', '') : ''}
    <p class="muted">כל מייל שנשלח (גם ידנית) מוסיף אוטומטית מעקב ל-5 ימים. מיילים שנשלחו מחוץ למערכת: "✉ מייל שנשלח", ותשובות: "↩ תשובה שהתקבלה".</p>`;
}

$('#today').addEventListener('click', async (e) => {
  const go = e.target.closest('[data-go]');
  if (go) return show(go.dataset.go);
  const btn = e.target.closest('[data-a]');
  if (!btn) return;
  const card = btn.closest('[data-id]');
  const leadId = +card.dataset.id;
  try {
    if (btn.dataset.a === 'open') return openLead(leadId);
    if (btn.dataset.a === 'del') return confirmDelete([leadId], btn.dataset.name);
    if (btn.dataset.a === 'reply') {
      const lead = await api(`/leads/${leadId}`);
      const subj = card.dataset.subject;
      return composeModal(lead, { subject: subj ? (/^re:/i.test(subj) ? subj : `Re: ${subj}`) : '' });
    }
    if (btn.dataset.a === 'done') await api(`/leads/${leadId}`, { method: 'PATCH', body: { nextFollowUpAt: null, nextAction: '' } });
    if (btn.dataset.a === 'snooze3' || btn.dataset.a === 'snooze7') {
      const days = btn.dataset.a === 'snooze3' ? 3 : 7;
      const d = new Date(Date.now() + days * 86400000);
      await api(`/leads/${leadId}`, { method: 'PATCH', body: { nextFollowUpAt: d.toISOString(), nextAction: 'מעקב' } });
    }
    toast('עודכן');
    renderFollowups();
  } catch (err) { fail(err); }
});

function interactionModal(kind) {
  const inbound = kind === 'EMAIL_IN';
  modal(`<h3>${inbound ? 'תשובה שהתקבלה' : 'מייל שנשלח ידנית'}</h3>
    <label>אימייל ${inbound ? 'השולח' : 'הנמען'}<input name="email" type="email" dir="ltr" required></label>
    <label>שם איש קשר (אם הליד חדש)<input name="name"></label>
    <label>חברה (אם הליד חדש)<input name="company"></label>
    <label>תאריך<input name="at" type="date" value="${dayStr(new Date())}"></label>
    <label>נושא<input name="subject"></label>
    <label>תוכן<textarea name="body" rows="8" placeholder="הדבק כאן את המייל"></textarea></label>
    <p class="muted">${inbound ? 'השלב יעבור ל"מעורב", רצפים יעצרו, ותיקבע תזכורת למענה ביומיים.' : 'השלב יעבור ל"נוצר קשר" ותיקבע תזכורת מעקב ל-5 ימים.'} ליד שלא קיים ייווצר.</p>`, async (fd) => {
    if (fd.at) fd.at = `${fd.at}T12:00:00`;
    const r = await api('/interactions', { method: 'POST', body: { ...fd, kind } });
    toast(r.created ? 'ליד חדש נוצר ותועד' : 'תועד');
    await loadMeta();
    refreshView();
    openLead(r.leadId);
  }, 'תיעוד');
}

// ---------------- Sequences ----------------
async function renderSequences() {
  sequences = await api('/sequences');
  $('#seq-list').innerHTML = sequences.length ? sequences.map((s) => `
    <div class="seq">
      <h3>${esc(s.name)}</h3>
      <div class="muted">${s.steps.length} צעדים · ${s.activeCount} פעילים · ${s._count.enrollments} סה״כ</div>
      <ol>${s.steps.map((st) => `<li>יום ${st.delayDays}: ${esc(st.subject)}</li>`).join('')}</ol>
      <div class="actions" style="display:flex;gap:8px">
        <button class="btn sm" data-edit="${s.id}">עריכה</button>
        <button class="btn sm danger" data-del="${s.id}">מחיקה</button>
      </div>
    </div>`).join('') : '<p class="muted">עדיין אין רצפים. צור רצף ראשון — לדוגמה מייל פתיחה ביום 0, תזכורת ביום 3 ומייל אחרון ביום 7.</p>';
  $('#seq-list').querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => editSequence(sequences.find((s) => s.id === +b.dataset.edit))));
  $('#seq-list').querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
    if (!confirm('למחוק את הרצף?')) return;
    try { await api(`/sequences/${b.dataset.del}`, { method: 'DELETE' }); renderSequences(); } catch (err) { fail(err); }
  }));
}

function editSequence(seq) {
  const steps = seq ? seq.steps : [{ delayDays: 0, subject: '', body: '' }, { delayDays: 3, subject: '', body: '' }, { delayDays: 7, subject: '', body: '' }];
  const stepHtml = (s, i) => `<div class="step">
    <div class="hdr"><b>צעד ${i + 1}</b> · יום <input type="number" min="0" name="d${i}" value="${s.delayDays}" required>
    <button type="button" class="btn ghost sm" data-preview="${i}">👁 תצוגה</button><button type="button" class="btn ghost sm" data-test="${i}">✉ בדיקה אליי</button><button type="button" class="btn ghost sm" data-rm="${i}">הסר</button></div>
    <input name="s${i}" placeholder="נושא — למשל: היי {{first_name}}" value="${esc(s.subject)}" required>
    <textarea name="b${i}" rows="4" placeholder="תוכן המייל" required>${esc(s.body)}</textarea>${INSERT_BAR(i)}</div>`;
  const form = modal(`<h3>${seq ? 'עריכת רצף' : 'רצף חדש'}</h3>
    <label>שם הרצף<input name="name" value="${esc(seq?.name)}" required></label>
    <div id="steps" style="display:flex;flex-direction:column;gap:10px">${steps.map(stepHtml).join('')}</div>
    <button type="button" class="btn" id="add-step">+ צעד</button>
    <p class="muted">קישור: הדבק כתובת או [טקסט](https://...). סרטון YouTube: [video:https://youtu.be/XXXX]. החתימה נוספת אוטומטית.</p>
    <p class="muted">היום נספר מרגע ההוספה לרצף. הרצף נעצר אוטומטית כשהליד משיב, חוזר (bounce) או מסיר עצמו.</p>`, async (fd) => {
    const n = form.querySelectorAll('.step').length;
    const body = { name: fd.name, steps: [] };
    form.querySelectorAll('.step').forEach((el) => {
      const i = el.querySelector('[name^="d"]').name.slice(1);
      body.steps.push({ delayDays: +fd[`d${i}`], subject: fd[`s${i}`], body: fd[`b${i}`] });
    });
    if (!n) throw new Error('steps_required');
    await api(seq ? `/sequences/${seq.id}` : '/sequences', { method: seq ? 'PUT' : 'POST', body });
    toast('הרצף נשמר');
    await loadMeta();
    renderSequences();
  });
  let next = steps.length;
  const bindRm = () => form.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => b.closest('.step').remove()));
  bindRm();
  $('#add-step', form).onclick = () => {
    $('#steps', form).insertAdjacentHTML('beforeend', stepHtml({ delayDays: '', subject: '', body: '' }, next++));
    bindRm();
  };
}

// ---------------- One email to several selected leads ----------------
function bulkMailModal(ids) {
  const rows = [...document.querySelectorAll('#leads-body tr[data-id]')].filter((tr) => ids.includes(+tr.dataset.id));
  const names = rows.map((tr) => tr.dataset.name);
  const form = modal(`<h3>מייל ל-${ids.length} לידים</h3>
    <div class="rcpts">${names.slice(0, 12).map((n) => `<span class="flag">${esc(n)}</span>`).join('')}${names.length > 12 ? `<span class="flag">+${names.length - 12}</span>` : ''}</div>
    <p class="muted">זה מייל בודד ולא קמפיין: כל ליד מקבל מייל משלו, הוא נרשם בציר הזמן שלו, ואחרי השליחה נוצר לו מעקב ל-5 ימים. תשובות יופיעו בטאב "דואר". לידים שהסירו את עצמם או שהכתובת שלהם חוזרת ידולגו.</p>
    <label>נושא<input name="subject" required></label>
    <label>תוכן, משתנים: {{name}}, {{first_name}}, {{company}}<textarea name="body" rows="9" required></textarea></label>
    ${INSERT_BAR('')}
    <div class="logrow"><button type="button" class="btn" data-preview="">👁 תצוגה מקדימה</button><button type="button" class="btn" data-test="">✉ שלח לי בדיקה</button></div>`, async (fd) => {
    const r = await api('/leads/bulk-email', { method: 'POST', body: { ids, subject: fd.subject, body: fd.body } });
    toast(`${r.queued} מיילים בתור${r.skipped.length ? ` · ${r.skipped.length} דולגו` : ''}`);
    refreshView();
  }, `שליחה ל-${ids.length}`);
  const first = form.querySelector('[name="subject"]');
  form.insertAdjacentHTML('beforeend', `<input type="hidden" name="leadId" value="${ids[0]}">`);
  first.focus();
}

// ---------------- Delete (one or many) ----------------
function confirmDelete(ids, label) {
  modal(`<h3>מחיקה</h3><p>למחוק ${esc(label)}? יימחקו גם היסטוריית המיילים והתיעוד של הליד. אי אפשר לשחזר.</p>`, async () => {
    await api('/leads/bulk-delete', { method: 'POST', body: { ids } });
    toast(ids.length > 1 ? `${ids.length} לידים נמחקו` : 'נמחק');
    if (ids.includes(mailSel)) mailSel = null;
    closeDrawer();
    loadMeta();
    refreshView();
  }, 'מחיקה');
}

// ---------------- Mail: conversations per lead ----------------
let mailSel = null;
let mailFilter = 'all';
const KIND_LABEL = { campaign: 'קמפיין', manual: 'אישי', reply: 'תשובה שהתקבלה', logged: 'נשלח מחוץ למערכת' };
const MSTATUS = { QUEUED: 'בתור', SENDING: 'נשלח כעת', DRAFT: 'ממתין לאישור' };

async function renderMail(forceThread = false) {
  const rows = await api('/mailbox');
  const q = $('#mail-q').value.trim().toLowerCase();
  const ok = (r) => (mailFilter === 'all' || (mailFilter === 'await' && r.awaiting) || (mailFilter === 'replied' && r.replies > 0)
    || (mailFilter === 'campaign' && r.campaign > 0) || (mailFilter === 'manual' && r.sent - r.campaign > 0))
    && (!q || `${r.lead.name} ${r.lead.email} ${r.lead.company || ''}`.toLowerCase().includes(q));
  const list = rows.filter(ok);
  const waiting = rows.filter((r) => r.awaiting).length;
  const b = $('#mail-count');
  b.textContent = waiting;
  b.classList.toggle('hidden', !waiting);
  $('#mail-filters').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.f === mailFilter));
  $('#mail-list').innerHTML = list.length ? list.map((r) => `
    <div class="mrow ${r.lead.id === mailSel ? 'sel' : ''} ${r.awaiting ? 'await' : ''}" data-id="${r.lead.id}">
      <div class="m1"><b>${esc(r.lead.name)}</b><time>${ago(r.last.at)}</time></div>
      <div class="m2 muted">${esc(r.lead.company || r.lead.email)}</div>
      <div class="m3"><span class="dir ${r.last.dir}">${r.last.dir === 'in' ? '↩ התקבל' : '→ נשלח'}</span> <span dir="auto">${esc(r.last.subject || r.last.snippet)}</span></div>
      <div class="m4">${r.awaiting ? '<span class="flag bad">להשיב</span>' : ''}${r.replies ? `<span class="flag good">${r.replies} תשובות</span>` : ''}${r.campaign ? '<span class="flag">קמפיין</span>' : ''}${r.pending ? `<span class="flag warn">${r.pending} בתור</span>` : ''}</div>
    </div>`).join('') : '<p class="muted pad">אין שיחות. מייל שתשלח, וגם תשובה שתתקבל, יופיעו כאן.</p>';
  $('#mail-list').querySelectorAll('.mrow').forEach((el) => el.addEventListener('click', () => { mailSel = +el.dataset.id; renderMail(true); }));
  if (mailSel && (forceThread || !$('#mail-thread .thread'))) await renderThread(mailSel);
  else if (!mailSel) $('#mail-thread').innerHTML = '<p class="muted pad">בחר שיחה מהרשימה, או כתוב מייל חדש.</p>';
}

async function renderThread(leadId) {
  const { lead, items } = await api(`/leads/${leadId}/thread`);
  const lastIn = [...items].reverse().find((i) => i.dir === 'in');
  const subj = (lastIn || items[items.length - 1] || {}).subject || '';
  const emailable = !lead.unsubscribed && !lead.bounced;
  $('#mail-thread').innerHTML = `<div class="thread">
    <div class="th-head">
      <div><h2>${esc(lead.name)}</h2><div class="muted" dir="ltr">${esc(lead.email)}${lead.company ? ` · ${esc(lead.company)}` : ''}</div></div>
      <div class="th-acts"><span class="pill" style="--c:var(--s-${lead.stage})">${STAGE_LABELS[lead.stage]}</span>
        <button class="btn sm" data-t="card">פתח כרטיס</button><button class="btn sm danger" data-t="del">מחיקה</button></div>
    </div>
    <div class="th-body">${items.length ? items.map((i) => `
      <div class="bub ${i.dir}">
        <div class="bh"><span class="kind ${i.kind}">${KIND_LABEL[i.kind] || ''}</span>${MSTATUS[i.status] ? `<span class="flag warn">${MSTATUS[i.status]}</span>` : ''}${i.opened ? '<span class="flag good">נפתח</span>' : ''}${i.clicked ? '<span class="flag good">לחיצה</span>' : ''}<time>${fmt(i.at)}</time></div>
        ${i.subject ? `<div class="bs" dir="auto">${esc(i.subject)}</div>` : ''}
        <div class="bb" dir="auto">${esc(i.body || '')}</div>
      </div>`).join('') : '<p class="muted pad">עוד לא נשלח או התקבל מייל מהליד הזה.</p>'}</div>
    ${emailable ? `<form class="th-reply" id="th-form">
      <input name="subject" placeholder="נושא" value="${esc(subj ? (/^re:/i.test(subj) ? subj : `Re: ${subj}`) : '')}" required>
      <textarea name="body" rows="7" placeholder="${lastIn ? 'כתוב תשובה…' : 'כתוב מייל…'}" required></textarea>
      <div class="logrow"><span class="muted" id="th-hint">החתימה נוספת אוטומטית. המייל יישלח בדקה הקרובה.</span>${lastIn ? '<button type="button" class="btn sm" id="th-suggest">✨ הצעת תשובה</button>' : ''}<button class="btn primary">${lastIn ? 'שלח תשובה' : 'שלח'}</button></div>
    </form>` : '<p class="muted pad">הליד הסיר את עצמו או שהכתובת חוזרת, לא ניתן לשלוח לו.</p>'}
  </div>`;
  const body = $('#mail-thread .th-body');
  body.scrollTop = body.scrollHeight;
  $('#mail-thread [data-t="card"]').onclick = () => openLead(leadId);
  $('#mail-thread [data-t="del"]').onclick = () => confirmDelete([leadId], lead.name);
  const f = $('#th-form');
  const suggest = async (force) => {
    const ta = f && f.querySelector('textarea');
    if (!ta || !lastIn || (!force && ta.value.trim())) return;
    const hint = $('#th-hint');
    hint.textContent = 'מכין הצעת תשובה…';
    try {
      const s = await api(`/leads/${leadId}/suggest-reply`, { method: 'POST', body: {} });
      if (mailSel !== leadId || !document.body.contains(ta) || (!force && ta.value.trim())) return;
      ta.value = s.text;
      hint.textContent = s.source === 'ai' ? 'הצעה אוטומטית. בדוק וערוך לפני שליחה.' : 'תבנית בסיסית (חסר ANTHROPIC_API_KEY בשרת להצעה מותאמת). ערוך לפני שליחה.';
    } catch (err) { hint.textContent = 'לא הצלחתי להכין הצעה, כתוב ידנית.'; }
  };
  if (f && lastIn && items[items.length - 1].dir === 'in') suggest(false);
  const sb = $('#th-suggest');
  if (sb) sb.onclick = () => suggest(true);
  if (f) f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`/leads/${leadId}/email`, { method: 'POST', body: Object.fromEntries(new FormData(f)) });
      toast('המייל בתור ויישלח בדקה הקרובה');
      renderMail(true);
    } catch (err) { fail(err); }
  };
}
$('#mail-q').addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(() => renderMail(), 250); });
$('#mail-filters').addEventListener('click', (e) => { if (e.target.dataset.f) { mailFilter = e.target.dataset.f; renderMail(); } });

// ---------------- Stats ----------------
async function renderStats() {
  const s = await api(`/stats?days=${$('#stats-days').value}`);
  const k = (v, l) => `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`;
  $('#stats').innerHTML = `
    <div class="kpis">
      ${k(s.sent, 'מיילים נשלחו')}${k(`${s.openRate}%`, 'אחוז פתיחה')}${k(`${s.clickRate}%`, 'אחוז הקלקה')}
      ${k(`${s.replyRate}%`, 'אחוז תשובה')}${k(`${s.bounceRate}%`, 'אחוז bounce')}${k(s.totalLeads, 'לידים')}
      ${k(`${s.winRate}%`, 'אחוז סגירה (מתוך סגורים)')}${k(`${s.sentToday} / ${s.queued}`, 'נשלחו היום / בתור')}
    </div>
    <div class="funnel"><h3 style="margin-top:0">משפך המרה לפי שלב</h3>
      ${s.funnel.map((f) => `<div class="fbar" style="--c:var(--s-${f.stage})"><span>${STAGE_LABELS[f.stage]}</span>
        <div class="track"><div class="fill" style="width:${f.conversion}%"></div></div>
        <span class="num">${f.reached} · ${f.conversion}%</span></div>`).join('')}
      <div class="fbar" style="--c:var(--s-LOST)"><span>${STAGE_LABELS.LOST}</span><div class="track"><div class="fill" style="width:${s.totalLeads ? (s.stages.LOST / s.totalLeads) * 100 : 0}%"></div></div><span class="num">${s.stages.LOST}</span></div>
      <p class="muted" style="margin-bottom:0">"הגיעו" = לידים שנמצאים בשלב הזה או מתקדם ממנו, מתוך כל הלידים שאינם אבודים. אחוזי מייל מחושבים לטווח הזמן שנבחר.</p>
    </div>`;
}

// ---------------- Import ----------------
$('#import-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('/import', { method: 'POST', body: new FormData(e.target) });
    $('#import-result').innerHTML = `<p><b>${r.created}</b> לידים נוצרו · <b>${r.updated}</b> עודכנו (שדות חסרים הושלמו) · <b>${r.duplicates.length}</b> ללא שינוי · <b>${r.noEmail.length}</b> בלי מייל · <b>${r.invalid.length}</b> שורות לא תקינות</p>
      ${r.noEmail.length ? `<details open><summary>שורות בלי כתובת מייל (לא נוצרו)</summary>${r.noEmail.map((d) => `שורה ${d.row}: ${esc(d.name)} ${esc(d.phone)}`).join('<br>')}</details>` : ''}
      ${r.duplicates.length ? `<details><summary>כפילויות</summary>${r.duplicates.map((d) => `שורה ${d.row}: ${esc(d.email)}`).join('<br>')}</details>` : ''}
      ${r.invalid.length ? `<details><summary>שורות לא תקינות</summary>${r.invalid.map((d) => `שורה ${d.row}: ${esc(d.reason)}`).join('<br>')}</details>` : ''}`;
    e.target.reset();
    loadMeta();
  } catch (err) { fail(err); }
});

$('#sent-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('/import-sent', { method: 'POST', body: new FormData(e.target) });
    $('#sent-result').innerHTML = `<p><b>${r.logged}</b> מיילים תועדו (<b>${r.created}</b> לידים חדשים) · <b>${r.skipped.length}</b> כבר מתועדים · <b>${r.invalid.length}</b> שורות לא תקינות</p>
      ${r.invalid.length ? `<details><summary>שורות לא תקינות</summary>${r.invalid.map((d) => `שורה ${d.row}: ${esc(d.reason)}`).join('<br>')}</details>` : ''}`;
    e.target.reset();
    loadMeta();
  } catch (err) { fail(err); }
});

const EML_REASON = { not_sent_by_you: 'לא נשלח מהכתובת שלך', no_external_recipient: 'אין נמען חיצוני', already_logged: 'כבר מתועד', unparseable: 'קובץ לא תקין' };
$('#eml-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('/import-eml', { method: 'POST', body: new FormData(e.target) });
    $('#eml-result').innerHTML = `<p><b>${r.logged}</b> מיילים צורפו ללידים (<b>${r.created}</b> לידים חדשים) · <b>${r.skipped.length}</b> דולגו · <b>${r.invalid.length}</b> שגיאות · נבדקו ${r.messages} הודעות</p>
      ${r.skipped.length ? `<details><summary>דולגו</summary>${r.skipped.map((d) => `${esc(d.label || '')} ${d.email ? `(${esc(d.email)})` : ''}: ${EML_REASON[d.reason] || esc(d.reason)}`).join('<br>')}</details>` : ''}
      ${r.invalid.length ? `<details><summary>שגיאות</summary>${r.invalid.map((d) => `${esc(d.file || '')} ${esc(d.email || '')}: ${EML_REASON[d.reason] || esc(d.reason)}`).join('<br>')}</details>` : ''}`;
    e.target.reset();
    loadMeta();
  } catch (err) { fail(err); }
});

// ---------------- Outbox ----------------
async function renderOutbox() {
  const rows = await api('/outbox');
  const drafts = rows.filter((m) => m.status === 'DRAFT').length;
  const b = $('#ob-count');
  b.textContent = drafts;
  b.classList.toggle('hidden', !drafts);
  $('#ob-list').innerHTML = rows.length ? rows.map((m) => `
    <div class="seq" data-id="${m.id}">
      <div><b>${esc(m.lead.name)}</b> <span class="muted">${esc(m.lead.email)}${m.lead.company ? ` · ${esc(m.lead.company)}` : ''}</span>
        <span class="flag ${m.status === 'DRAFT' ? 'warn' : 'good'}">${m.status === 'DRAFT' ? 'ממתין לאישור' : 'בתור, נשלח בדקה הקרובה'}</span>
        ${m.stepIndex != null ? `<span class="muted">צעד ${m.stepIndex + 1} ברצף</span>` : '<span class="muted">מייל בודד</span>'}</div>
      <label>נושא<input data-f="subject" value="${esc(m.subject)}"></label>
      <label>תוכן<textarea data-f="body" rows="8">${esc(m.body)}</textarea></label>
      <div class="actions" style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn sm" data-act="save">שמור עריכה</button>
        <button class="btn sm" data-act="preview">👁 תצוגה</button>
        <button class="btn sm" data-act="test">✉ בדיקה אליי</button>
        ${m.status === 'DRAFT' ? '<button class="btn sm primary" data-act="approve">אשר ושלח</button>' : ''}
        <button class="btn sm danger" data-act="cancel">בטל</button>
      </div>
    </div>`).join('') : '<p class="muted">אין מיילים בהמתנה.</p>';
}
$('#ob-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const card = btn.closest('[data-id]');
  const mid = card.dataset.id;
  const subject = card.querySelector('[data-f=subject]').value;
  const body = card.querySelector('[data-f=body]').value;
  try {
    if (btn.dataset.act === 'preview') return await showPreview({ subject, body });
    if (btn.dataset.act === 'test') { const r = await api('/test-email', { method: 'POST', body: { subject, body } }); return toast(`נשלח לבדיקה אל ${r.sentTo}`); }
    if (btn.dataset.act === 'cancel') { if (!confirm('לבטל את ההודעה?')) return; await api(`/messages/${mid}/cancel`, { method: 'POST' }); }
    if (btn.dataset.act === 'save') { await api(`/messages/${mid}`, { method: 'PATCH', body: { subject, body } }); toast('נשמר'); }
    if (btn.dataset.act === 'approve') { await api(`/messages/${mid}`, { method: 'PATCH', body: { subject, body } }); await api(`/messages/${mid}/approve`, { method: 'POST' }); toast('אושר, נשלח בדקה הקרובה'); }
    renderOutbox();
  } catch (err) { fail(err); }
});
$('#ob-approve-all').onclick = async () => {
  if (!confirm('לאשר ולשלח את כל ההודעות הממתינות, בלי לערוך?')) return;
  try { const r = await api('/outbox/approve-all', { method: 'POST' }); toast(`${r.approved} אושרו`); renderOutbox(); } catch (err) { fail(err); }
};

// ---------------- Settings ----------------
async function renderSettings() {
  const s = await api('/settings');
  $('#set-sig').value = s.signatureHtml;
  $('#set-approval').checked = s.requireApproval;
}
$('#set-save').onclick = async () => {
  try {
    await api('/settings', { method: 'PUT', body: { signatureHtml: $('#set-sig').value, requireApproval: $('#set-approval').checked } });
    toast('נשמר');
  } catch (err) { fail(err); }
};
$('#set-prev').onclick = async () => {
  try {
    // preview uses the saved signature; save first so the preview reflects edits
    await api('/settings', { method: 'PUT', body: { signatureHtml: $('#set-sig').value, requireApproval: $('#set-approval').checked } });
    const r2 = await api('/preview', { method: 'POST', body: { subject: 'דוגמה', body: 'Hi {{first_name}},\nזה מייל לדוגמה.\n[video:https://youtu.be/S8zjWCywGj4]' } });
    $('#pv-meta').innerHTML = `נושא: <b>${esc(r2.subject)}</b> · החתימה נשמרה`;
    $('#pv-frame').srcdoc = r2.html;
    $('#preview-dlg').showModal();
  } catch (err) { fail(err); }
};

// ---------------- Wiring ----------------
const views = { mail: renderMail, followups: renderFollowups, outbox: renderOutbox, settings: renderSettings, board: renderBoard, leads: renderLeads, sequences: renderSequences, stats: renderStats, import: async () => {}, gmdss: async () => { const f = $('#gmdss-frame'); if (!f.getAttribute('src')) f.src = '/gmdss?embed=1'; } };
function refreshView() { views[view]().catch(fail); }
function routeOf() {
  const m = location.hash.match(/^#\/([a-z]+)(?:\/lead\/(\d+))?$/);
  return m && views[m[1]] ? { view: m[1], lead: m[2] ? +m[2] : null } : null;
}
// Back/Forward or a hand-edited address: bring the screen in line with the hash.
window.addEventListener('hashchange', () => {
  const r = routeOf();
  if (!r) return;
  if (r.view !== view) show(r.view, true);
  if (r.lead !== drawerLead) {
    if (r.lead) openLead(r.lead, true).catch(fail);
    else { drawerLead = null; closeDrawer(); }
  }
});
function show(v, replace) {
  view = v;
  const r = routeOf();
  if (!r || r.view !== v) setHash(`#/${v}`, replace); // same view: keep a /lead/<id> suffix intact
  document.querySelectorAll('.view').forEach((el) => el.classList.toggle('hidden', el.id !== `view-${v}`));
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  try { localStorage.setItem('crm.view', v); } catch { /* storage unavailable */ }
  refreshView();
}
$('#tabs').addEventListener('click', (e) => { if (e.target.dataset.view) show(e.target.dataset.view); });
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-action="new-lead"]')) newLead();
  if (e.target.closest('[data-action="compose"]')) composeModal(null);
  if (e.target.closest('[data-action="paste-reply"]')) interactionModal('EMAIL_IN');
  if (e.target.closest('[data-action="log-sent"]')) interactionModal('EMAIL_OUT');
  if (e.target.closest('[data-action="import-eml"]')) { show('import'); setTimeout(() => $('#eml-panel').scrollIntoView({ behavior: 'smooth' }), 50); }
});
$('#scrim').onclick = closeDrawer;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
$('#logout').onclick = async () => { await fetch('/auth/logout', { method: 'POST' }); location.href = '/login'; };
$('#new-seq').onclick = () => editSequence(null);
$('#stats-days').onchange = renderStats;
$('#bulk-mail').onclick = () => {
  const ids = [...document.querySelectorAll('.sel:checked')].map((c) => +c.value);
  if (!ids.length) return toast('סמן לידים לשליחה', true);
  bulkMailModal(ids);
};
$('#split-tags').onclick = async () => {
  try {
    const d = await api('/leads/split-tags?dry=1', { method: 'POST', body: {} });
    if (!d.changed) return toast(`אין מה לפצל ב-${d.checked} לידים עם תגיות`);
    const f = d.filled;
    if (!confirm(`לפצל תגיות לשדות נפרדים?
${d.changed} לידים ישתנו
עדיפות: ${f.priority}, מדינה: ${f.country}, סוג: ${f.segment}, אתר: ${f.website}
תגיות שינוקו: ${f.tagsCleaned}
(שדות שכבר מלאים לא יידרסו)`)) return;
    await api('/leads/split-tags', { method: 'POST', body: {} });
    toast('התגיות פוצלו לשדות');
    await loadMeta();
    renderLeads();
  } catch (err) { fail(err); }
};
$('#auto-seg').onclick = async () => {
  try {
    const d = await api('/leads/auto-segment?dry=1', { method: 'POST', body: {} });
    const lines = Object.entries(d.counts).map(([k, n]) => `${k}: ${n}`).join('\n');
    if (!lines) return toast(`לא זוהה סוג באף אחד מ-${d.checked} הלידים ללא סוג`, true);
    if (!confirm(`לקבוע סוג אוטומטית לפי שם החברה?\n${lines}\nללא זיהוי: ${d.unclassified}\n(ערכים קיימים לא יידרסו)`)) return;
    await api('/leads/auto-segment', { method: 'POST', body: {} });
    toast('הסוגים נקבעו');
    await loadMeta();
    renderLeads();
  } catch (err) { fail(err); }
};
$('#bulk-del').onclick = () => {
  const ids = [...document.querySelectorAll('.sel:checked')].map((c) => +c.value);
  if (!ids.length) return toast('סמן לידים למחיקה', true);
  confirmDelete(ids, `${ids.length} לידים`);
};
let deb;
['#board-q', '#f-q'].forEach((s) => $(s).addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(refreshView, 250); }));
['#f-stage', '#f-tag', '#f-source', '#f-inactive', '#f-stale', '#f-priority', '#f-country', '#f-activity', '#f-segment'].forEach((s) => $(s).addEventListener('change', renderLeads));
$('#sel-all').onchange = (e) => document.querySelectorAll('.sel').forEach((c) => { c.checked = e.target.checked; });
$('#bulk-enroll').onclick = async () => {
  const seqId = $('#bulk-seq').value;
  const ids = [...document.querySelectorAll('.sel:checked')].map((c) => +c.value);
  if (!seqId || !ids.length) return toast('בחר רצף ולידים', true);
  try {
    const r = await api(`/sequences/${seqId}/enroll`, { method: 'POST', body: { leadIds: ids } });
    toast(`${r.enrolled} נוספו · ${r.skipped} דולגו`);
    renderLeads();
  } catch (err) { fail(err); }
};

(async function init() {
  const r = await fetch('/auth/me');
  if (!r.ok) { location.href = '/login'; return; }
  ({ csrf } = await r.json());
  await loadMeta();
  renderFollowups().catch(() => {});
  api('/mailbox').then((rows) => { const n = rows.filter((r) => r.awaiting).length; const b = $('#mail-count'); b.textContent = n; b.classList.toggle('hidden', !n); }).catch(() => {});
  api('/outbox').then((rows) => { const n = rows.filter((m) => m.status === 'DRAFT').length; const b = $('#ob-count'); b.textContent = n; b.classList.toggle('hidden', !n); }).catch(() => {});
  let saved = 'followups';
  try { saved = localStorage.getItem('crm.view') || 'board'; } catch { /* ignore */ }
  const route = routeOf();
  show(route ? route.view : (views[saved] ? saved : 'followups'), true);
  if (route && route.lead) openLead(route.lead, true).catch(fail);
  setInterval(() => { if (!document.hidden && !$('#modal').open && $('#drawer').classList.contains('hidden')) refreshView(); }, 60000);
}());
