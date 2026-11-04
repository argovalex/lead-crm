/* CRM dashboard — vanilla JS, no build step. */
const STAGE_LABELS = { NEW: 'חדש', CONTACTED: 'נוצר קשר', ENGAGED: 'מעורב', QUALIFIED: 'מתאים', PROPOSAL: 'הצעה', WON: 'נסגר ✓', LOST: 'אבוד' };
const STAGES = Object.keys(STAGE_LABELS);
const ACT = {
  CREATED: ['＋', 'ליד נוצר'], NOTE: ['✎', 'הערה'], STAGE_CHANGED: ['→', 'שינוי שלב'],
  EMAIL_QUEUED: ['⧗', 'מייל בתור'], EMAIL_SENT: ['✉', 'מייל נשלח'], EMAIL_DELIVERED: ['✓', 'נמסר'],
  EMAIL_OPENED: ['👁', 'נפתח'], EMAIL_CLICKED: ['↗', 'לחיצה על קישור'], EMAIL_REPLIED: ['↩', 'השיב'],
  EMAIL_BOUNCED: ['✕', 'חזר (bounce)'], EMAIL_COMPLAINED: ['⚠', 'סומן כספאם'], EMAIL_FAILED: ['✕', 'שליחה נכשלה'],
  UNSUBSCRIBED: ['⊘', 'הסיר עצמו מהתפוצה'], SEQUENCE_ENROLLED: ['▶', 'נוסף לרצף'], STALE_FLAGGED: ['⏸', 'סומן כרדום'],
};
const REASONS = { manual: 'ידני', 'auto:email_sent': 'אוטומטי · נשלח מייל', 'auto:click': 'אוטומטי · לחיצה', 'auto:reply': 'אוטומטי · תשובה' };

let csrf = '';
let meta = { stages: STAGES, sources: [], tags: [] };
let sequences = [];
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (d) => (d ? new Date(d).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : '');
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
  board.innerHTML = STAGES.map((s) => {
    const items = rows.filter((l) => l.stage === s);
    return `<div class="col" data-stage="${s}" style="--c:var(--s-${s})">
      <h3>${STAGE_LABELS[s]} <span class="count">${items.length}</span></h3>
      <div class="cards-col">${items.map((l) => `
        <div class="card" draggable="true" data-id="${l.id}">
          <div class="n">${esc(l.name)}</div>
          <div class="meta">${esc(l.company || l.email)}</div>
          <div class="meta">${ago(l.lastActivityAt)}</div>
          ${flagsHtml(l)}
        </div>`).join('')}</div></div>`;
  }).join('');

  board.querySelectorAll('.card').forEach((c) => {
    c.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', c.dataset.id); c.classList.add('dragging'); });
    c.addEventListener('dragend', () => c.classList.remove('dragging'));
    c.addEventListener('click', () => openLead(+c.dataset.id));
  });
  board.querySelectorAll('.col').forEach((col) => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('over'); });
    col.addEventListener('dragleave', () => col.classList.remove('over'));
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('over');
      const leadId = e.dataTransfer.getData('text/plain');
      const card = board.querySelector(`.card[data-id="${leadId}"]`);
      if (!card || card.closest('.col') === col) return;
      col.querySelector('.cards-col').prepend(card); // optimistic
      try {
        await api(`/leads/${leadId}/stage`, { method: 'POST', body: { stage: col.dataset.stage } });
        toast(`הועבר ל"${STAGE_LABELS[col.dataset.stage]}"`);
      } catch (err) { fail(err); }
      renderBoard();
    });
  });
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
  if ($('#f-stale').checked) p.set('stale', 'true');
  const rows = await api(`/leads?${p}`);
  $('#leads-body').innerHTML = rows.length ? rows.map((l) => `
    <tr data-id="${l.id}">
      <td><input type="checkbox" class="sel" value="${l.id}"></td>
      <td>${esc(l.name)}</td><td>${esc(l.email)}</td><td>${esc(l.company)}</td>
      <td><span class="pill" style="--c:var(--s-${l.stage})">${STAGE_LABELS[l.stage]}</span></td>
      <td>${esc(l.source)}</td><td>${(l.tags || []).map(esc).join(', ')}</td>
      <td title="${fmt(l.lastActivityAt)}">${ago(l.lastActivityAt)}${l.stale ? ' <span class="flag warn">רדום</span>' : ''}</td>
    </tr>`).join('') : '<tr><td colspan="8" class="muted">אין לידים תואמים</td></tr>';
  $('#leads-body').querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.matches('input')) return;
    openLead(+tr.dataset.id);
  }));
}

async function loadMeta() {
  meta = await api('/leads/meta');
  const fill = (sel, items, label = (x) => x) => {
    const cur = $(sel).value;
    $(sel).innerHTML = $(sel).options[0].outerHTML + items.map((i) => `<option value="${esc(i)}">${esc(label(i))}</option>`).join('');
    $(sel).value = cur;
  };
  fill('#f-stage', STAGES, (s) => STAGE_LABELS[s]);
  fill('#f-tag', meta.tags);
  fill('#f-source', meta.sources);
  sequences = await api('/sequences');
  fill('#bulk-seq', sequences.map((s) => String(s.id)), (id) => sequences.find((s) => String(s.id) === id).name);
}

// ---------------- Lead drawer ----------------
function closeDrawer() { $('#drawer').classList.add('hidden'); $('#scrim').classList.add('hidden'); }

async function openLead(id) {
  const l = await api(`/leads/${id}`);
  const actText = (a) => {
    const d = a.data || {};
    if (a.type === 'STAGE_CHANGED') return `${STAGE_LABELS[d.from]} ← ${STAGE_LABELS[d.to]} <span class="muted">(${REASONS[d.reason] || esc(d.reason)})</span>`;
    if (a.type === 'NOTE') return esc(d.text);
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
    <form id="d-form">
      <div class="row">
        <label>שם<input name="name" value="${esc(l.name)}" required></label>
        <label>שלב<select name="stage">${STAGES.map((s) => `<option value="${s}" ${s === l.stage ? 'selected' : ''}>${STAGE_LABELS[s]}</option>`).join('')}</select></label>
        <label>טלפון<input name="phone" value="${esc(l.phone)}" dir="ltr"></label>
        <label>חברה<input name="company" value="${esc(l.company)}"></label>
        <label>מקור<input name="source" value="${esc(l.source)}"></label>
        <label>אחראי<input name="owner" value="${esc(l.owner)}"></label>
        <label class="full">תגיות (מופרדות בפסיק)<input name="tags" value="${esc((l.tags || []).join(', '))}"></label>
        <label class="full">הערות<textarea name="notes" rows="2">${esc(l.notes)}</textarea></label>
      </div>
      <div class="actions"><button class="btn primary">שמירה</button></div>
    </form>
    <div class="actions">
      <button class="btn" id="d-email" ${emailable ? '' : 'disabled'}>✉ שליחת מייל</button>
      <select id="d-seq" ${emailable ? '' : 'disabled'}><option value="">הוסף לרצף…</option>${sequences.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
      <button class="btn" id="d-replied">↩ סמן שהשיב</button>
      <button class="btn" id="d-unenroll">עצור רצפים</button>
      <button class="btn danger" id="d-del">מחיקה</button>
    </div>
    <section><h4>רצפים</h4>${enr}</section>
    <section>
      <h4>הוספת הערה</h4>
      <form id="d-note" style="display:flex;gap:8px"><input name="text" placeholder="סיכום שיחה, משימה…" style="flex:1" required><button class="btn">הוסף</button></form>
    </section>
    <section><h4>ציר זמן</h4><ul class="timeline">${l.activities.map((a) => `
      <li><span class="ic">${(ACT[a.type] || ['•'])[0]}</span><div><b>${(ACT[a.type] || [, a.type])[1]}</b> ${actText(a)}<time>${fmt(a.createdAt)}</time></div></li>`).join('')}</ul></section>`;

  $('#drawer').classList.remove('hidden');
  $('#scrim').classList.remove('hidden');
  $('#d-close').onclick = closeDrawer;
  const refresh = () => { openLead(id); refreshView(); };

  $('#d-form').onsubmit = async (e) => {
    e.preventDefault();
    try { await api(`/leads/${id}`, { method: 'PATCH', body: Object.fromEntries(new FormData(e.target)) }); toast('נשמר'); refresh(); } catch (err) { fail(err); }
  };
  $('#d-note').onsubmit = async (e) => {
    e.preventDefault();
    try { await api(`/leads/${id}/notes`, { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); refresh(); } catch (err) { fail(err); }
  };
  $('#d-replied').onclick = async () => { try { await api(`/leads/${id}/replied`, { method: 'POST' }); toast('סומן — רצפים נעצרו'); refresh(); } catch (err) { fail(err); } };
  $('#d-unenroll').onclick = async () => { try { const r = await api(`/leads/${id}/unenroll`, { method: 'POST' }); toast(`נעצרו ${r.stopped} רצפים`); refresh(); } catch (err) { fail(err); } };
  $('#d-del').onclick = async () => {
    if (!confirm(`למחוק את ${l.name}? הפעולה אינה הפיכה.`)) return;
    try { await api(`/leads/${id}`, { method: 'DELETE' }); closeDrawer(); toast('נמחק'); refreshView(); } catch (err) { fail(err); }
  };
  $('#d-seq').onchange = async (e) => {
    if (!e.target.value) return;
    try { await api(`/leads/${id}/enroll`, { method: 'POST', body: { sequenceId: +e.target.value } }); toast('נוסף לרצף'); refresh(); } catch (err) { fail(err); e.target.value = ''; }
  };
  $('#d-email').onclick = () => modal(`
    <h3>מייל ל-${esc(l.name)}</h3>
    <label>נושא<input name="subject" required></label>
    <label>תוכן — אפשר להשתמש ב-{{name}}, {{first_name}}, {{company}}<textarea name="body" rows="8" required></textarea></label>
    <p class="muted">המייל ייכנס לתור וישלח בדקה הקרובה. קישור הסרה מתווסף אוטומטית.</p>`, async (fd) => {
    await api(`/leads/${id}/email`, { method: 'POST', body: fd });
    toast('המייל בתור לשליחה');
    refresh();
  }, 'שליחה');
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
  dlg.showModal();
  return form;
}

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
    <button type="button" class="btn ghost sm" data-rm="${i}">הסר</button></div>
    <input name="s${i}" placeholder="נושא — למשל: היי {{first_name}}" value="${esc(s.subject)}" required>
    <textarea name="b${i}" rows="4" placeholder="תוכן המייל" required>${esc(s.body)}</textarea></div>`;
  const form = modal(`<h3>${seq ? 'עריכת רצף' : 'רצף חדש'}</h3>
    <label>שם הרצף<input name="name" value="${esc(seq?.name)}" required></label>
    <div id="steps" style="display:flex;flex-direction:column;gap:10px">${steps.map(stepHtml).join('')}</div>
    <button type="button" class="btn" id="add-step">+ צעד</button>
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
    $('#import-result').innerHTML = `<p><b>${r.created}</b> לידים נוצרו · <b>${r.duplicates.length}</b> כפילויות דולגו · <b>${r.invalid.length}</b> שורות לא תקינות</p>
      ${r.duplicates.length ? `<details><summary>כפילויות</summary>${r.duplicates.map((d) => `שורה ${d.row}: ${esc(d.email)}`).join('<br>')}</details>` : ''}
      ${r.invalid.length ? `<details><summary>שורות לא תקינות</summary>${r.invalid.map((d) => `שורה ${d.row}: ${esc(d.reason)}`).join('<br>')}</details>` : ''}`;
    e.target.reset();
    loadMeta();
  } catch (err) { fail(err); }
});

// ---------------- Wiring ----------------
let view = 'board';
const views = { board: renderBoard, leads: renderLeads, sequences: renderSequences, stats: renderStats, import: async () => {} };
function refreshView() { views[view]().catch(fail); }
function show(v) {
  view = v;
  document.querySelectorAll('.view').forEach((el) => el.classList.toggle('hidden', el.id !== `view-${v}`));
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  try { localStorage.setItem('crm.view', v); } catch { /* storage unavailable */ }
  refreshView();
}
$('#tabs').addEventListener('click', (e) => { if (e.target.dataset.view) show(e.target.dataset.view); });
document.addEventListener('click', (e) => { if (e.target.closest('[data-action="new-lead"]')) newLead(); });
$('#scrim').onclick = closeDrawer;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
$('#logout').onclick = async () => { await fetch('/auth/logout', { method: 'POST' }); location.href = '/login'; };
$('#new-seq').onclick = () => editSequence(null);
$('#stats-days').onchange = renderStats;
let deb;
['#board-q', '#f-q'].forEach((s) => $(s).addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(refreshView, 250); }));
['#f-stage', '#f-tag', '#f-source', '#f-inactive', '#f-stale'].forEach((s) => $(s).addEventListener('change', renderLeads));
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
  let saved = 'board';
  try { saved = localStorage.getItem('crm.view') || 'board'; } catch { /* ignore */ }
  show(views[saved] ? saved : 'board');
  setInterval(() => { if (!document.hidden && !$('#modal').open && $('#drawer').classList.contains('hidden')) refreshView(); }, 60000);
}());
