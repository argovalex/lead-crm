/* Tasks & follow-ups UI. Loaded before app.js; uses its globals (api, $, esc, modal, toast, openLead...) at call time only. */
const TYPE_LABELS = {
  INITIAL_EMAIL: 'מייל פתיחה', FOLLOWUP_EMAIL: 'מייל מעקב', PHONE_CALL: 'שיחת טלפון', MEETING: 'פגישה', SEND_PROPOSAL: 'שליחת הצעה',
  PRODUCT_DEMO: 'הדגמת מוצר', NEGOTIATION: 'משא ומתן', FINAL_DECISION: 'החלטה סופית', OTHER: 'אחר',
};
const TASK_STATUS = { OPEN: 'פתוחה', IN_PROGRESS: 'בביצוע', WAITING: 'ממתינה לתשובה', COMPLETED: 'הושלמה', CANCELLED: 'בוטלה' };
const ST_CLASS = { OPEN: 'tk-open', IN_PROGRESS: 'tk-prog', WAITING: 'tk-wait', COMPLETED: 'tk-done', CANCELLED: 'tk-cancel' };
const ACTIVE_ST = ['OPEN', 'IN_PROGRESS', 'WAITING'];
const TASK_ERR = {
  next_action_exists: 'כבר יש פעולה הבאה פעילה לליד הזה', completed_preserved: 'משימה שהושלמה נשמרת בהיסטוריה (אפשר לבטל אותה)',
  title_required: 'כותרת חובה', invalid_date: 'תאריך לא תקין', invalid_time: 'שעה לא תקינה', task_not_active: 'המשימה אינה פעילה',
  invalid_task_type: 'סוג משימה לא תקין', invalid_priority: 'עדיפות לא תקינה',
};
const taskFail = (e) => toast(TASK_ERR[e.message] || (typeof ERR !== 'undefined' && ERR[e.message]) || `שגיאה: ${e.message}`, true);

const ymd = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
const todayYmd = () => ymd(new Date());
const plusYmd = (n) => ymd(new Date(Date.now() + n * 86400000));
const taskDate = (t) => `${new Date(t.dueDate).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'numeric' })}${t.dueTime ? ` <span dir="ltr">${esc(t.dueTime)}</span>` : ''}`;
const typeOpts = (sel) => Object.entries(TYPE_LABELS).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v}</option>`).join('');
const prioOpts = (sel) => ['A', 'B', 'C'].map((p) => `<option ${p === (sel || 'B') ? 'selected' : ''}>${p}</option>`).join('');
const activeStatusOpts = (sel) => ACTIVE_ST.map((s) => `<option value="${s}" ${s === sel ? 'selected' : ''}>${TASK_STATUS[s]}</option>`).join('');

function statusBadge(t) {
  if (t.bucket === 'overdue') return '<span class="tkst tk-over">באיחור</span>';
  return `<span class="tkst ${ST_CLASS[t.status]}">${TASK_STATUS[t.status]}</span>`;
}
const prioFlag = (p) => `<span class="flag prio-${esc(p)}">${esc(p)}</span>`;

// ------------------------------------------------------------------ dashboard
const TB = { view: 'all', sort: 'due', dir: 'asc', f: {}, built: false, timer: null, rows: [] };
const TB_VIEWS = [['all', 'הכל'], ['overdue', 'באיחור'], ['today', 'היום'], ['week', 'השבוע'], ['waiting', 'ממתינות לתשובה'], ['completed', 'הושלמו']];

function buildTasksBoard(host) {
  host.innerHTML = `
    <div class="tb-banner hidden" id="tb-banner"></div>
    <div class="kpis2 tb-kpis" id="tb-kpis"></div>
    <div class="toolbar wrap">
      <div class="seg" id="tb-views">${TB_VIEWS.map(([v, l]) => `<button data-v="${v}" class="${v === TB.view ? 'on' : ''}">${l}</button>`).join('')}</div>
      <span class="spacer"></span>
      <button class="btn primary" id="tb-new">+ משימה</button>
    </div>
    <div class="toolbar wrap tb-filters">
      <input id="tb-q" type="search" placeholder="חיפוש משימה / ארגון" dir="auto">
      <input id="tb-org" placeholder="ארגון" dir="auto">
      <select id="tb-country"><option value="">כל המדינות</option></select>
      <select id="tb-leadType"><option value="">כל סוגי הלידים</option></select>
      <select id="tb-prog" aria-label="התקדמות"><option value="">כל ההתקדמות</option><option value="z">0% תקוע</option><option value="lo">1-39%</option><option value="mid">40-79%</option><option value="hi">80% ומעלה</option></select>
      <select id="tb-taskType"><option value="">כל סוגי המשימות</option>${Object.entries(TYPE_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
      <select id="tb-status"><option value="">כל הסטטוסים</option>${Object.entries(TASK_STATUS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
      <button class="btn ghost hidden" id="tb-clear" type="button">נקה סינון</button>
    </div>
    <div class="table-wrap"><table class="tbl tasks-tbl">
      <thead><tr>
        <th data-sort="due" class="sortable">תאריך יעד</th><th data-sort="org" class="sortable">ארגון</th><th data-sort="title" class="sortable">משימה</th>
        <th data-sort="type" class="sortable">סוג</th><th>התקדמות</th><th data-sort="status" class="sortable">סטטוס</th><th>פעולות</th>
      </tr></thead>
      <tbody id="tb-body"></tbody>
    </table></div>
    <h3 class="tb-sub">פעולות הבאות לפי ליד</h3>`;
  TB.built = true;
  const onFilter = () => {
    for (const k of ['q', 'org', 'country', 'leadType', 'prog', 'taskType', 'status']) TB.f[k] = $(`#tb-${k}`).value.trim();
    $('#tb-clear').classList.toggle('hidden', !Object.values(TB.f).some(Boolean));
    clearTimeout(TB.timer);
    TB.timer = setTimeout(() => renderTasksBoard().catch(() => {}), 220);
  };
  host.querySelector('.tb-filters').addEventListener('input', onFilter);
  host.querySelector('.tb-filters').addEventListener('change', onFilter);
  $('#tb-clear').onclick = () => {
    host.querySelectorAll('.tb-filters input, .tb-filters select').forEach((el) => { el.value = ''; });
    onFilter();
  };
  $('#tb-new').onclick = () => taskModal({ onDone: renderTasksBoard });
  host.addEventListener('click', onBoardClick);
  api('/tasks/meta').then((m) => {
    const fill = (id, items) => { $(id).insertAdjacentHTML('beforeend', items.map((i) => `<option value="${esc(i)}">${esc(i)}</option>`).join('')); };
    fill('#tb-country', m.countries); fill('#tb-leadType', m.leadTypes);
  }).catch(() => {});
}

async function renderTasksBoard() {
  const host = $('#tasks-board');
  if (!host) return null;
  if (!TB.built) buildTasksBoard(host);
  const p = new URLSearchParams({ view: TB.view, sort: TB.sort, dir: TB.dir });
  for (const [k, v] of Object.entries(TB.f)) if (v && k !== 'prog') p.set(k, v);
  const [all, sum] = await Promise.all([api(`/tasks?${p}`), api('/tasks/summary')]);
  const rows = all.filter((t) => progMatch(t.lead.progress && t.lead.progress.pct, TB.f.prog));
  TB.rows = rows;
  const k = (key, n, label, cls = '') => `<div class="k ${n ? cls : ''}" data-kpi="${key}"><b>${n}</b>${label}</div>`;
  $('#tb-kpis').innerHTML = k('overdue', sum.overdue, 'משימות באיחור', 'red') + k('today', sum.today, 'להיום', 'warn') + k('week', sum.week, 'השבוע (7 ימים)')
    + k('waiting', sum.waiting, 'ממתינות לתשובה', 'warn') + k('noNext', sum.noNextAction, 'לידים בלי פעולה הבאה', 'warn');
  const banner = $('#tb-banner');
  banner.classList.toggle('hidden', !sum.needsReview);
  banner.innerHTML = sum.needsReview ? `<b>${sum.needsReview}</b> לידים השיבו וממתינים לבדיקה שלך. <a href="#" data-kpi="reply">מעבר לרשימה</a>` : '';
  host.querySelectorAll('#tb-views button').forEach((b) => b.classList.toggle('on', b.dataset.v === TB.view));
  host.querySelectorAll('th.sortable').forEach((th) => { th.dataset.dir = th.dataset.sort === TB.sort ? TB.dir : ''; });
  $('#tb-body').innerHTML = rows.length ? rows.map((t) => `
    <tr data-id="${t.id}" data-lead="${t.leadId}" class="${t.bucket === 'overdue' ? 'is-over' : ''} ${isActiveTask(t) ? '' : 'is-done'}">
      <td class="c-due ${t.bucket === 'overdue' ? 'over' : ''}">${taskDate(t)}</td>
      <td class="c-org"><a href="#" class="org-link" data-lead="${t.leadId}" dir="auto">${esc(t.lead.company || t.lead.name)}</a>${t.lead.country ? `<div class="muted">${esc(t.lead.country)}</div>` : ''}</td>
      <td class="c-title" dir="auto">${t.isNextAction && isActiveTask(t) ? '<span class="nx" title="הפעולה הבאה של הליד">★</span> ' : ''}${esc(t.title)}${t.description ? `<div class="muted c-desc" dir="auto">${esc(t.description)}</div>` : ''}</td>
      <td>${TYPE_LABELS[t.taskType] || ''}</td>
      <td>${progHtml(t.lead)}</td>
      <td>${statusBadge(t)}</td>
      <td class="c-acts">${isActiveTask(t) ? `
        <button class="btn sm" data-act="done" title="סמן כהושלמה" aria-label="סמן כהושלמה">✓</button>
        <button class="btn sm" data-act="resched" title="שינוי תאריך" aria-label="שינוי תאריך">📅</button>
        <button class="btn sm ghost" data-act="edit" title="עריכה" aria-label="עריכה">✎</button>` : `<button class="btn sm ghost" data-act="reopen" title="פתח מחדש" aria-label="פתח מחדש">↺</button>`}
        ${t.status === 'COMPLETED' ? '' : '<button class="btn sm ghost danger" data-act="del" title="מחיקה" aria-label="מחיקה">🗑</button>'}</td>
    </tr>`).join('') : '<tr><td colspan="7" class="muted">אין משימות תואמות</td></tr>';
  return sum;
}
const isActiveTask = (t) => ACTIVE_ST.includes(t.status);
// The shared modal form keeps one click handler; add ours without dropping it (and without piling up listeners).
function onModalClick(form, fn) { const prev = form.onclick; form.onclick = (e) => { fn(e); return prev && prev.call(form, e); }; }
const chipClick = (form) => onModalClick(form, (e) => { const b = e.target.closest('[data-d]'); if (b) { e.preventDefault(); form.querySelector('[name="dueDate"]').value = plusYmd(Number(b.dataset.d)); } });

async function onBoardClick(e) {
  const a = e.target.closest('a');
  if (a) e.preventDefault();
  const v = e.target.closest('#tb-views [data-v]');
  if (v) { TB.view = v.dataset.v; return renderTasksBoard().catch(taskFail); }
  const th = e.target.closest('th[data-sort]');
  if (th) {
    TB.dir = TB.sort === th.dataset.sort && TB.dir === 'asc' ? 'desc' : 'asc';
    TB.sort = th.dataset.sort;
    return renderTasksBoard().catch(taskFail);
  }
  const kpi = e.target.closest('[data-kpi]');
  if (kpi) {
    const key = kpi.dataset.kpi;
    if (key === 'noNext') return noNextModal();
    if (key === 'reply') { const g = document.querySelector('#today .fu-group'); if (g) g.scrollIntoView({ behavior: 'smooth' }); return; }
    TB.view = key; return renderTasksBoard().catch(taskFail);
  }
  const org = e.target.closest('.org-link');
  if (org) return openLead(+org.dataset.lead);
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const tr = btn.closest('tr');
  const t = TB.rows.find((x) => x.id === +tr.dataset.id);
  if (t) taskAction(btn.dataset.act, t, renderTasksBoard);
}

async function noNextModal() {
  const rows = await api('/tasks/no-next-action').catch(taskFail);
  if (!rows) return;
  const form = modal(`<h3>לידים בלי פעולה הבאה (${rows.length})</h3>
    <div class="nn-list">${rows.map((l) => `<div class="nn-row" data-lead="${l.id}"><b dir="auto">${esc(l.company || l.name)}</b><span class="muted">${esc(l.country || '')}</span><button type="button" class="btn sm" data-open="${l.id}">פתח כרטיס</button><button type="button" class="btn sm primary" data-plan="${l.id}">קבע פעולה</button></div>`).join('') || '<p class="muted">לכל הלידים הפעילים יש פעולה הבאה.</p>'}</div>`, async () => {}, 'סגירה');
  onModalClick(form, (e) => {
    const o = e.target.closest('[data-open]'); const p = e.target.closest('[data-plan]');
    if (o) { $('#modal').close(); openLead(+o.dataset.open); }
    if (p) { $('#modal').close(); setTimeout(() => taskModal({ leadId: +p.dataset.plan, next: true, onDone: renderTasksBoard }), 50); }
  });
}

// ------------------------------------------------------------------ actions shared by dashboard and lead card
async function taskAction(act, t, done) {
  try {
    if (act === 'done') {
      if (t.isNextAction) return completeModal(t, done);
      await api(`/tasks/${t.id}/complete`, { method: 'POST', body: {} });
      toast('המשימה הושלמה');
    } else if (act === 'resched') return rescheduleModal(t, done);
    else if (act === 'edit') return taskModal({ task: t, onDone: done });
    else if (act === 'reopen') {
      await api(`/tasks/${t.id}`, { method: 'PATCH', body: { status: 'OPEN' } });
      toast('נפתחה מחדש');
    } else if (act === 'next') {
      await api(`/tasks/${t.id}/next-action`, { method: 'POST' });
      toast('הוגדרה כפעולה הבאה');
    } else if (act === 'del') {
      if (!confirm(`למחוק את המשימה "${t.title}"?`)) return;
      await api(`/tasks/${t.id}`, { method: 'DELETE' });
      toast('נמחקה');
    }
    await done();
    refreshTaskBadges();
  } catch (err) { taskFail(err); }
}

function refreshTaskBadges() { if (typeof renderFollowups === 'function' && view === 'followups') renderFollowups().catch(() => {}); }

function completeModal(t, done) {
  modal(`<h3>השלמת משימה</h3>
    <p dir="auto"><b>${esc(t.title)}</b></p>
    <p class="muted">הליד נשאר פתוח. אפשר לקבוע עכשיו את הפעולה הבאה (אופציונלי).</p>
    <label>פעולה הבאה<input name="nTitle" placeholder="למשל: מייל מעקב. להשאיר ריק = בלי פעולה הבאה" dir="auto"></label>
    <div class="logrow"><select name="nType">${typeOpts('FOLLOWUP_EMAIL')}</select><input name="nDate" type="date" value="${plusYmd(3)}"><input name="nTime" type="time"><select name="nPriority">${prioOpts(t.priority)}</select></div>`, async (fd) => {
    const body = {};
    if (fd.nTitle && fd.nTitle.trim()) body.next = { title: fd.nTitle, taskType: fd.nType, dueDate: fd.nDate, dueTime: fd.nTime || null, priority: fd.nPriority, isNextAction: true };
    await api(`/tasks/${t.id}/complete`, { method: 'POST', body });
    toast(body.next ? 'הושלמה, נקבעה פעולה הבאה' : 'המשימה הושלמה');
    await done();
    refreshTaskBadges();
  }, 'סיום');
}

function rescheduleModal(t, done) {
  const form = modal(`<h3>שינוי תאריך</h3><p dir="auto"><b>${esc(t.title)}</b></p>
    <div class="logrow"><input name="dueDate" type="date" value="${ymd(t.dueDate)}" required><input name="dueTime" type="time" value="${esc(t.dueTime || '')}">
    <span class="chips"><button type="button" class="btn sm" data-d="0">היום</button><button type="button" class="btn sm" data-d="1">מחר</button><button type="button" class="btn sm" data-d="3">+3</button><button type="button" class="btn sm" data-d="7">שבוע</button></span></div>`, async (fd) => {
    await api(`/tasks/${t.id}/reschedule`, { method: 'POST', body: { dueDate: fd.dueDate, dueTime: fd.dueTime || null } });
    toast('התאריך עודכן');
    await done();
    refreshTaskBadges();
  }, 'שמירה');
  chipClick(form);
}

// Create or edit. With `task` it edits; otherwise creates for leadId (or asks which lead).
async function taskModal({ task = null, leadId = null, next = false, preset = {}, onDone = async () => {} } = {}) {
  const t = task || {};
  const needLead = !task && !leadId;
  const form = modal(`<h3>${task ? 'עריכת משימה' : 'משימה חדשה'}</h3>
    ${needLead ? `<label>ליד / ארגון<input name="leadPick" list="tk-leads" dir="auto" autocomplete="off" required placeholder="התחל להקליד שם, חברה או אימייל"></label><datalist id="tk-leads"></datalist>` : ''}
    <label>כותרת<input name="title" value="${esc(t.title || preset.title || '')}" dir="auto" required></label>
    <div class="logrow"><select name="taskType" aria-label="סוג">${typeOpts(t.taskType || preset.taskType || 'OTHER')}</select><select name="priority" aria-label="עדיפות">${prioOpts(t.priority || preset.priority)}</select>
    <select name="status" aria-label="סטטוס">${activeStatusOpts(t.status || 'OPEN')}</select></div>
    <div class="logrow"><input name="dueDate" type="date" value="${t.dueDate ? ymd(t.dueDate) : (preset.dueDate || plusYmd(1))}" required><input name="dueTime" type="time" value="${esc(t.dueTime || '')}" aria-label="שעה (אופציונלי)">
    <span class="chips"><button type="button" class="btn sm" data-d="0">היום</button><button type="button" class="btn sm" data-d="1">מחר</button><button type="button" class="btn sm" data-d="3">+3</button><button type="button" class="btn sm" data-d="7">שבוע</button></span></div>
    <label>תיאור<textarea name="description" rows="3" dir="auto">${esc(t.description || '')}</textarea></label>
    ${task && !isActiveTask(task) ? '' : `<label class="chk"><input type="checkbox" name="isNext" ${(task ? task.isNextAction : next) ? 'checked' : ''}> הפעולה הבאה של הליד (אחת בלבד לכל ליד)</label>`}`, async (fd) => {
    const base = { title: fd.title, taskType: fd.taskType, priority: fd.priority, status: fd.status || undefined, dueDate: fd.dueDate, dueTime: fd.dueTime || null, description: fd.description };
    if (task) {
      await api(`/tasks/${task.id}`, { method: 'PATCH', body: base });
      if (fd.isNext && !task.isNextAction) await api(`/tasks/${task.id}/next-action`, { method: 'POST' });
    } else {
      let id = leadId;
      if (needLead) {
        const hit = (form._leads || []).find((l) => `${l.company || l.name} · ${l.email}` === fd.leadPick || l.email === fd.leadPick);
        if (!hit) throw new Error('בחר ליד מהרשימה');
        id = hit.id;
      }
      const body = { ...base, leadId: id, isNextAction: !!fd.isNext, ...(preset.dedupeKey ? { dedupeKey: preset.dedupeKey } : {}) };
      try { await api('/tasks', { method: 'POST', body }); } catch (err) {
        if (err.message === 'next_action_exists' && confirm('כבר יש פעולה הבאה לליד הזה. להחליף אותה בזו? (הקודמת תישאר כמשימה רגילה)')) await api('/tasks', { method: 'POST', body: { ...body, replaceNext: true } });
        else throw err;
      }
    }
    toast('נשמר');
    await onDone();
    refreshTaskBadges();
  }, 'שמירה');
  chipClick(form);
  if (needLead) {
    api('/leads').then((all) => {
      form._leads = all;
      form.querySelector('#tk-leads').innerHTML = all.map((l) => `<option value="${esc(`${l.company || l.name} · ${l.email}`)}">`).join('');
    }).catch(() => {});
  }
  return form;
}

// After an email is queued: offer a follow-up task (never creates one on its own).
function offerFollowupTask(leadId, messageId, name) {
  taskModal({ leadId, preset: { title: `מעקב${name ? `: ${name}` : ''}`, taskType: 'FOLLOWUP_EMAIL', dueDate: plusYmd(5), dedupeKey: messageId ? `followup:msg:${messageId}` : undefined }, onDone: async () => {} });
  const h = document.querySelector('#modal-form h3');
  if (h) h.textContent = 'ליצור משימת מעקב למייל שנשלח?';
}

// ------------------------------------------------------------------ lead card sections
function nextActionHtml(l, next, stages, stageLabels) {
  const t = next || {};
  const over = next && next.bucket === 'overdue';
  const state = next
    ? `${NEXT_ICON(next.title)} <b dir="auto">${esc(next.title)}</b> · ${TYPE_LABELS[next.taskType]} · ${taskDate(next)} ${statusBadge(next)}`
    : (l.nextFollowUpAt ? `${NEXT_ICON(l.nextAction)} <b dir="auto">${esc(l.nextAction || 'מעקב')}</b> · ${dateHe(l.nextFollowUpAt)}` : '<span class="muted">אין פעולה הבאה מתוכננת</span>');
  return `<section class="nextstep"><h4>הפעולה הבאה</h4>
    <div class="ns-state ${over ? 'over' : ''}">${state}${next ? '<span class="muted"> · מופיע בטאב "היום"</span>' : ''}</div>
    <form id="d-next">
      <div class="logrow">
        <select name="stage" aria-label="שלב">${stages.map((s) => `<option value="${s}" ${s === l.stage ? 'selected' : ''}>${stageLabels[s]}</option>`).join('')}</select>
        <select name="taskType" aria-label="סוג פעולה">${typeOpts(t.taskType || typeFromText(l.nextAction))}</select>
        <input name="title" value="${esc(t.title || l.nextAction || '')}" dir="auto" placeholder="מה עושים: להתקשר, לשלוח הצעה…" autocomplete="off">
      </div>
      <div class="logrow">
        <input name="dueDate" type="date" value="${t.dueDate ? ymd(t.dueDate) : dayStr(l.nextFollowUpAt)}" aria-label="תאריך">
        <input name="dueTime" type="time" value="${esc(t.dueTime || '')}" aria-label="שעה (אופציונלי)">
        <select name="priority" aria-label="עדיפות">${prioOpts(t.priority || l.priority)}</select>
        <select name="status" aria-label="סטטוס">${activeStatusOpts(t.status || 'OPEN')}</select>
        <span class="chips"><button type="button" class="btn sm" data-d="0">היום</button><button type="button" class="btn sm" data-d="1">מחר</button><button type="button" class="btn sm" data-d="3">+3</button><button type="button" class="btn sm" data-d="7">שבוע</button></span>
      </div>
      <textarea name="description" rows="2" dir="auto" placeholder="תיאור (אופציונלי)">${esc(t.description || '')}</textarea>
      <div class="logrow"><span class="muted">שינוי מופיע מיד ב"היום" ובכרטיס. השלמת הפעולה לא סוגרת את הליד.</span>
        ${next ? '<button type="button" class="btn" id="d-next-done">✓ הושלם</button>' : ''}<button class="btn primary">שמירה</button></div>
    </form></section>`;
}
const typeFromText = (a) => (/טלפון|שיחה/.test(a || '') ? 'PHONE_CALL' : /פגישה/.test(a || '') ? 'MEETING' : /הצעה/.test(a || '') ? 'SEND_PROPOSAL' : /להשיב|מייל|מעקב/.test(a || '') ? 'FOLLOWUP_EMAIL' : 'OTHER');

function leadTasksHtml(list) {
  const active = list.filter((t) => isActiveTask(t) && !t.isNextAction);
  const closed = list.filter((t) => !isActiveTask(t));
  const row = (t) => `<div class="trow ${t.bucket === 'overdue' ? 'is-over' : ''}" data-id="${t.id}">
    <span class="t-main"><b dir="auto">${esc(t.title)}</b> <span class="muted">${TYPE_LABELS[t.taskType]}</span>${t.description ? `<div class="muted c-desc" dir="auto">${esc(t.description)}</div>` : ''}</span>
    <span class="t-date ${t.bucket === 'overdue' ? 'over' : ''}">${taskDate(t)}</span>${prioFlag(t.priority)}${statusBadge(t)}
    <span class="t-acts">${isActiveTask(t) ? `<button type="button" class="btn sm" data-ta="done" title="הושלמה" aria-label="הושלמה">✓</button><button type="button" class="btn sm" data-ta="resched" title="שינוי תאריך" aria-label="שינוי תאריך">📅</button><button type="button" class="btn sm ghost" data-ta="next" title="הפוך לפעולה הבאה" aria-label="הפוך לפעולה הבאה">★</button><button type="button" class="btn sm ghost" data-ta="edit" title="עריכה" aria-label="עריכה">✎</button>` : '<button type="button" class="btn sm ghost" data-ta="reopen" title="פתח מחדש" aria-label="פתח מחדש">↺</button>'}${t.status === 'COMPLETED' ? '' : '<button type="button" class="btn sm ghost danger" data-ta="del" title="מחיקה" aria-label="מחיקה">🗑</button>'}</span></div>`;
  return `<section id="d-tasks"><h4>משימות נוספות <button type="button" class="btn sm" data-ta="add">+ משימה</button></h4>
    ${active.length ? active.map(row).join('') : '<p class="muted">אין משימות נוספות.</p>'}
    ${closed.length ? `<details class="dd"><summary>הושלמו / בוטלו (${closed.length})</summary>${closed.map(row).join('')}</details>` : ''}</section>`;
}

// Wires the Next Action form and the Additional Tasks list inside the lead card.
function bindLeadTasks(leadId, list, refresh) {
  const next = list.find((t) => t.isNextAction && isActiveTask(t));
  const form = $('#d-next');
  form.addEventListener('click', (e) => { const b = e.target.closest('[data-d]'); if (b) form.querySelector('[name="dueDate"]').value = plusYmd(Number(b.dataset.d)); });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    try {
      const lead = await api(`/leads/${leadId}`);
      if (fd.stage && fd.stage !== lead.stage) await api(`/leads/${leadId}/stage`, { method: 'POST', body: { stage: fd.stage } });
      const hasContent = fd.title.trim() || fd.dueDate;
      if (hasContent) {
        const body = { title: fd.title.trim() || TYPE_LABELS[fd.taskType], taskType: fd.taskType, priority: fd.priority, status: fd.status, dueDate: fd.dueDate || todayYmd(), dueTime: fd.dueTime || null, description: fd.description };
        if (next) await api(`/tasks/${next.id}`, { method: 'PATCH', body });
        else await api('/tasks', { method: 'POST', body: { ...body, leadId, isNextAction: true } });
      }
      toast('נשמר');
      refresh();
    } catch (err) { taskFail(err); }
  };
  const done = $('#d-next-done');
  if (done) done.onclick = () => taskAction('done', next, async () => refresh());
  $('#d-tasks').onclick = (e) => {
    const b = e.target.closest('[data-ta]');
    if (!b) return;
    if (b.dataset.ta === 'add') return taskModal({ leadId, onDone: async () => refresh() });
    const t = list.find((x) => x.id === +b.closest('.trow').dataset.id);
    if (t) taskAction(b.dataset.ta, t, async () => refresh());
  };
}
