// Клиент дашборда: главная цель → лестница рубежей → аспекты рубежа → задачи.
// Получает обновления от сервера в реальном времени.
import { calm, countUp, floatPlus, wave, streakHit, milestone, scopeConfetti, shades, closedBadge, showFinale, play, vibrate, initSoundToggle } from './fx.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('ru-RU');

let state = null;
let view = null;        // рубеж, который сейчас смотрят (по умолчанию активный)
let sel = null;         // выбранный аспект
let editMode = false;
let pending = null;     // { id, mode: 'close' | 'reopen' }
const open = new Set(); // задачи с раскрытыми критериями

// Для анимаций: последние показанные числа и одноразовые отметки «только что».
let shown = null;
const fresh = new Set();
const held = new Set();
const settling = new Set();
const justClosed = new Set();

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t.hideTimer);
  t.hideTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
  return data;
}

const lsGet = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

const taskById = (id) => state.tasks.find((t) => t.id === id);
const scopeById = (id) => state.scopes.find((s) => s.id === id);
const msById = (id) => state.milestones.find((m) => m.id === id);
const msSummary = (id) => state.summary.milestones.find((m) => m.id === id);
const viewSummary = () => msSummary(view);
const scopeSummary = (id) => viewSummary().scopes.find((s) => s.id === id);
const openBlockers = (t) => state.summary.blockersOpen[t.id] || [];
const tasksOf = (scopeId) => state.tasks
  .filter((t) => t.milestone === view && t.scope === scopeId)
  .sort((a, b) => (a.done && !held.has(a.id)) - (b.done && !held.has(b.id)) || a.createdAt - b.createdAt);
const isClosed = (s) => s.percent === 100 && s.tasksTotal > 0;
const pctHtml = (n) => `${n}<small>%</small>`;
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) : '');

function snapshot(ms) {
  return { ms: ms.id, total: ms.percent, scopes: Object.fromEntries(ms.scopes.map((s) => [s.id, { percent: s.percent, share: s.share }])) };
}

function renderGoal() {
  const { goal } = state;
  $('goalTitle').textContent = goal.title;
  const m = goal.metric || {};
  const next = (m.ladder || []).find((s) => s.value > m.value);
  $('metric').innerHTML = m.label
    ? `<b>${esc(m.label)}: ${nf.format(m.value || 0)}</b>${next ? `<span>следующая ступень ${nf.format(next.value)}${next.label ? ` — ${esc(next.label)}` : ''}</span>` : ''}`
    : '';
  if (document.activeElement !== $('gT')) $('gT').value = goal.title;
  if (document.activeElement !== $('gM')) $('gM').value = m.value ?? 0;
  $('gMl').textContent = m.label || 'Показатель';
  $('gA').innerHTML = state.milestones.map((x) => `<option value="${esc(x.id)}" ${x.id === state.activeMilestone ? 'selected' : ''}>${esc(x.title)}</option>`).join('');
}

function renderLadder() {
  $('ladder').innerHTML = state.milestones.map((m, i) => {
    const s = msSummary(m.id);
    const status = s.closed ? 'взят' : m.id === state.activeMilestone ? 'сейчас' : '';
    return `<li><button type="button" class="step${s.closed ? ' done' : ''}${m.id === state.activeMilestone ? ' active' : ''}" data-ms="${esc(m.id)}" aria-pressed="${m.id === view}">
      <span class="num">${s.closed ? '✓' : i + 1}</span>
      <span class="sttl">${esc(m.title)}</span>
      <span class="sdate">${esc(m.date)}</span>
      <span class="bar"><i style="width:${s.percent}%"></i></span>
      <span class="spct">${s.tasksTotal ? `${s.percent}%` : 'нет задач'}${status ? ` · ${status}` : ''}</span>
    </button></li>`;
  }).join('');
}

// animate: данные изменились, налив и счётчики идут от прошлых значений.
function render(animate = false) {
  if (!state) return;
  if (!view || !msById(view)) view = state.activeMilestone;
  const ms = msById(view);
  const sum = viewSummary();
  const from = animate && shown?.ms === view ? shown : null;
  const barFrom = from && !calm ? from : null;
  const idx = state.milestones.indexOf(ms) + 1;

  document.title = `${ms.title}: ${sum.percent}% — ${state.goal.title}`;
  renderGoal();
  renderLadder();

  $('msKicker').textContent = `Рубеж ${idx}${ms.date ? ` · ${ms.date}` : ''}${view === state.activeMilestone ? ' · сейчас' : ''}`;
  $('msTitle').textContent = ms.title;
  $('msCriterion').textContent = ms.criterion ? `Взят, когда: ${ms.criterion}` : '';
  $('hero').innerHTML = pctHtml(sum.percent);
  $('mainbar').setAttribute('aria-label', `Прогресс рубежа ${sum.percent}%`);
  $('mainbar').innerHTML = sum.scopes.map((s) => {
    const cls = isClosed(s) ? `sealed${justClosed.has(s.id) ? ' justsealed' : ''}` : '';
    const w = barFrom?.scopes[s.id]?.share ?? s.share;
    return `<i class="${cls}" data-w="${s.share}" style="width:${w}%;background:${s.color}" title="${esc(s.name)}: ${Math.round(s.share)}% рубежа"></i>`;
  }).join('');

  const withTasks = sum.scopes.filter((s) => s.tasksTotal);
  if (!sel || !scopeById(sel) || !scopeSummary(sel).tasksTotal) sel = [...withTasks].sort((a, b) => a.percent - b.percent)[0]?.id ?? sum.scopes[0]?.id;

  const aims = state.aims[view] || {};
  $('scopes').innerHTML = state.scopes.map((s) => {
    const ss = scopeSummary(s.id);
    const p = ss.percent;
    const empty = !ss.tasksTotal;
    const closed = isClosed(ss);
    const cls = ['sc', closed && 'closed', closed && justClosed.has(s.id) && 'justclosed', empty && 'noitems'].filter(Boolean).join(' ');
    const w = barFrom?.scopes[s.id]?.percent ?? p;
    return `<button class="${cls}" type="button" data-scope="${esc(s.id)}" aria-pressed="${sel === s.id}" style="--c:${s.color}">
      <span class="n"><span class="dot" style="background:${s.color}"></span><span>${esc(s.name)}<small>${empty ? 'в этом рубеже задач нет' : `${ss.tasksDone} из ${ss.tasksTotal} задач`}</small></span></span>
      <span class="bar"><i data-w="${p}" style="width:${w}%;background:${s.color}"></i></span>
      <span class="p">${empty ? '—' : closed ? closedBadge : pctHtml(p)}</span></button>`;
  }).join('');
  justClosed.clear();

  if (barFrom) {
    void $('scopes').offsetWidth; // фиксируем старую ширину, чтобы сработал transition
    document.querySelectorAll('#mainbar i, #scopes .bar i').forEach((i) => { i.style.width = `${i.dataset.w}%`; });
  }
  if (from) {
    countUp($('hero'), from.total, sum.percent, { delay: 300, format: pctHtml });
    sum.scopes.forEach((s) => {
      const el = document.querySelector(`.sc[data-scope="${CSS.escape(s.id)}"]:not(.closed):not(.noitems) .p`);
      if (el && from.scopes[s.id]) countUp(el, from.scopes[s.id].percent, s.percent, { format: pctHtml });
    });
  }
  shown = snapshot(sum);
  renderTasks();
}

function renderTasks() {
  const scope = scopeById(sel);
  const aim = (state.aims[view] || {})[sel];
  $('l3h').innerHTML = scope ? `<span class="dot" style="background:${scope.color}"></span>${esc(scope.name)}` : 'Задачи';
  $('aim').textContent = aim || '';
  $('aim').hidden = !aim;
  const list = scope ? tasksOf(scope.id) : [];
  const cls = (t) => [t.done && 'done', fresh.has(t.id) && 'justdone', settling.has(t.id) && 'settle', open.has(t.id) && 'open'].filter(Boolean).join(' ');
  $('tasks').innerHTML =
    `<ul class="cl" style="--c:${scope?.color ?? 'var(--accent)'}">${list.map((t) => {
      const doneN = t.criteria.filter((c) => c.done).length;
      const waits = openBlockers(t);
      const crit = t.criteria.length ? `<span class="cnt${doneN === t.criteria.length ? ' full' : ''}" title="Отмечено критериев">${doneN}/${t.criteria.length}</span>` : '';
      const wait = !t.done && waits.length ? `<span class="wait" title="Ждёт закрытия других задач">ждёт ${waits.length}</span>` : '';
      const details = open.has(t.id) ? `<div class="det">
        ${t.criteria.length ? `<ul class="crits">${t.criteria.map((c, i) => `<li><label><input type="checkbox" data-crit="${esc(t.id)}" data-i="${i}" ${c.done ? 'checked' : ''} ${t.done ? 'disabled' : ''}><span>${esc(c.text)}</span></label></li>`).join('')}</ul>` : '<p class="note">Критериев нет.</p>'}
        ${t.blockedBy.length ? `<p class="note"><b>Зависит от:</b> ${t.blockedBy.map((b) => { const x = taskById(b); return x ? `<span class="${x.done ? 'ok' : 'no'}">${esc(x.title)}</span>` : ''; }).join(', ')}</p>` : ''}
        ${t.done ? `<p class="note"><b>Принято:</b> ${esc(t.acceptedBy)}${t.doneAt ? `, ${fmtDate(t.doneAt)}` : ''}</p>` : ''}
      </div>` : '';
      return `<li class="${cls(t)}" data-task="${esc(t.id)}">
        <div class="row">
          <label><span class="ck"><input type="checkbox" data-id="${esc(t.id)}" ${t.done ? 'checked' : ''}><svg viewBox="0 0 18 18" aria-hidden="true"><path d="M4.5 9.5l3.3 3.1 5.7-6.6"/></svg></span><span class="t">${esc(t.title)}</span></label>
          ${wait}${crit}
          ${editMode ? `<span class="w" title="Вес задачи">вес ${t.weight}</span><button class="del" type="button" data-del="${esc(t.id)}" aria-label="Удалить задачу">×</button>` : ''}
          <button class="more" type="button" data-more="${esc(t.id)}" aria-expanded="${open.has(t.id)}" aria-label="Критерии задачи">▾</button>
        </div>${details}
      </li>`;
    }).join('')}</ul>` +
    (list.length ? '' : '<p class="empty">У этого аспекта в рубеже пока нет задач.</p>') +
    (editMode ? `<form class="add" id="addForm">
      <div class="addrow">
        <input name="ttl" placeholder="Результат, например «Котики первой волны в финальном арте»" aria-label="Новая задача" maxlength="200">
        <select name="weight" aria-label="Вес задачи"><option value="1">вес 1</option><option value="2" selected>вес 2</option><option value="3">вес 3</option></select>
      </div>
      <textarea name="crit" rows="3" placeholder="Критерии закрытия, по одному на строку" aria-label="Критерии закрытия"></textarea>
      <button class="btn" type="submit">Добавить задачу</button></form>` : '');
  fresh.clear();
  settling.clear();
}

// Закрытые задачи уезжают вниз: запоминаем позиции, перерисовываем и плавно двигаем (FLIP).
function flipTasks(ids) {
  ids.forEach((id) => { held.delete(id); settling.add(id); });
  const rows = () => [...document.querySelectorAll('.cl > li[data-task]')];
  const before = new Map(rows().map((li) => [li.dataset.task, li.getBoundingClientRect().top]));
  renderTasks();
  rows().forEach((li) => {
    const dy = (before.get(li.dataset.task) ?? NaN) - li.getBoundingClientRect().top;
    if (dy) li.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 500, easing: 'cubic-bezier(.2, .7, .2, 1)' });
  });
}

const barOf = (id) => document.querySelector(`.sc[data-scope="${CSS.escape(id)}"] .bar`);

function tasksClosedFx(deltas, count, prevTotal) {
  const total = viewSummary().percent;
  deltas.forEach((delta, id) => {
    const s = scopeSummary(id);
    const bar = barOf(id);
    if (!bar || delta <= 0) return;
    floatPlus(bar, s.percent, `+${delta}%`, s.color, 150);
    wave(bar, s.percent, s.color, 650);
    wave($('mainbar'), total, s.color, 950);
  });
  const n = streakHit($('hero').querySelector('small') || $('hero'), count);
  play('task', Math.min(n - 1, 6) * 2);
  vibrate('task');
  const crossed = [75, 50, 25].find((m) => prevTotal < m && total >= m && total < 100);
  if (crossed) setTimeout(() => milestone($('hero'), $('mainbar'), crossed), 1000);
}

function scopeClosedFx(id) {
  setTimeout(() => {
    const bar = barOf(id);
    if (bar) scopeConfetti(bar, shades(scopeById(id).color));
    play('scope');
    vibrate('scope');
  }, 650);
}

function finale(msId) {
  const s = msSummary(msId);
  const list = state.tasks.filter((t) => t.milestone === msId);
  const weightOf = (id) => list.filter((t) => t.scope === id).reduce((n, t) => n + t.weight, 0);
  const totalW = list.reduce((n, t) => n + t.weight, 0) || 1;
  const withTasks = s.scopes.filter((x) => x.tasksTotal);
  showFinale({
    kicker: 'Рубеж взят',
    title: esc(msById(msId).title),
    tasksDone: s.tasksDone,
    scopesDone: withTasks.length,
    scopesTotal: withTasks.length,
    scopesLabel: 'аспектов',
    segments: withTasks.map((x) => ({ color: x.color, share: (weightOf(x.id) / totalW) * 100 })),
  });
}

// Пришло новое состояние: находим закрытые задачи, аспекты и рубеж и проигрываем эффекты.
function celebrate(prev) {
  const was = (id) => prev.tasks.find((t) => t.id === id);
  const closedTasks = state.tasks.filter((t) => t.done && was(t.id) && !was(t.id).done);
  const prevMs = prev.summary.milestones.find((m) => m.id === view);
  const curMs = msSummary(view);
  const closedScopes = prevMs && curMs ? curMs.scopes.filter((s) => {
    const before = prevMs.scopes.find((x) => x.id === s.id);
    return before && before.percent < 100 && s.percent === 100 && s.tasksTotal;
  }) : [];
  const closedMs = state.summary.milestones.filter((m) => {
    const before = prev.summary.milestones.find((x) => x.id === m.id);
    return before && !before.closed && m.closed;
  });

  const inView = closedTasks.filter((t) => t.milestone === view);
  const moving = calm ? [] : inView.filter((t) => t.scope === sel).map((t) => t.id);
  moving.forEach((id) => { fresh.add(id); held.add(id); });
  closedScopes.forEach((s) => justClosed.add(s.id));
  const from = shown;
  render(true);

  if (inView.length && from?.ms === view) {
    const deltas = new Map([...new Set(inView.map((t) => t.scope))].map((id) => [id, scopeSummary(id).percent - (from.scopes[id]?.percent ?? 0)]));
    tasksClosedFx(deltas, inView.length, from.total);
  }
  if (moving.length) setTimeout(() => flipTasks(moving), 750);
  closedScopes.forEach((s) => { scopeClosedFx(s.id); toast(`Аспект «${s.name}» в рубеже закрыт полностью`); });
  closedMs.forEach((m) => setTimeout(() => finale(m.id), closedScopes.length ? 1600 : 900));
}

// Диалог закрытия: все критерии отмечены, зависимости закрыты, указано, кто принял.
function askClose(t) {
  pending = { id: t.id, mode: 'close' };
  const waits = openBlockers(t).map(taskById).filter(Boolean);
  $('dTitle').textContent = 'Закрыть задачу?';
  $('dBody').innerHTML = `<p>«${esc(t.title)}» будет отмечена принятой для всей команды.</p>
    ${t.criteria.length ? `<p class="dl">Подтвердите каждый критерий:</p><ul class="crits dcrits">${t.criteria.map((c, i) => `<li><label><input type="checkbox" name="c${i}" ${c.done ? 'checked' : ''}><span>${esc(c.text)}</span></label></li>`).join('')}</ul>` : ''}
    ${waits.length ? `<p class="block">Закрыть пока нельзя. Сначала должны быть закрыты: ${waits.map((w) => `«${esc(w.title)}»`).join(', ')}.</p>` : ''}
    <label class="dl" for="dWho">Кто принял результат</label>
    <input id="dWho" name="who" maxlength="80" autocomplete="name" value="${esc(lsGet('acceptedBy'))}" ${waits.length ? 'disabled' : ''}>`;
  $('dOk').textContent = 'Задача принята';
  syncCloseBtn();
  $('dlg').showModal();
  if (!waits.length) $('dWho').focus();
}

function syncCloseBtn() {
  if (pending?.mode !== 'close') return;
  const t = taskById(pending.id);
  const boxes = [...$('dBody').querySelectorAll('.dcrits input')];
  const ok = t && !openBlockers(t).length && boxes.every((b) => b.checked) && $('dWho')?.value.trim();
  $('dOk').disabled = !ok;
}

function askReopen(t) {
  pending = { id: t.id, mode: 'reopen' };
  $('dTitle').textContent = 'Вернуть задачу в работу?';
  $('dBody').innerHTML = `<p>«${esc(t.title)}» снова станет открытой, и прогресс рубежа уменьшится. Отметки критериев сохранятся.</p>`;
  $('dOk').textContent = 'Вернуть в работу';
  $('dOk').disabled = false;
  $('dlg').showModal();
}

$('dBody').addEventListener('input', syncCloseBtn);
$('dBody').addEventListener('change', syncCloseBtn);

$('dForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const p = pending;
  const t = p && taskById(p.id);
  if (!t) { $('dlg').close(); return; }
  try {
    if (p.mode === 'close') {
      const checks = [...$('dBody').querySelectorAll('.dcrits input')].map((b) => b.checked);
      const who = $('dWho').value.trim();
      await api('PATCH', `/api/tasks/${encodeURIComponent(t.id)}`, { ...(checks.length ? { checks } : {}), done: true, acceptedBy: who });
      lsSet('acceptedBy', who);
      toast('Задача принята');
    } else {
      await api('PATCH', `/api/tasks/${encodeURIComponent(t.id)}`, { done: false });
    }
    $('dlg').close();
    pending = null;
  } catch (err) { toast(err.message); }
});
$('dNo').addEventListener('click', () => { $('dlg').close(); pending = null; });
$('dlg').addEventListener('close', () => { pending = null; });

$('editBtn').addEventListener('click', () => {
  editMode = !editMode;
  $('editBtn').textContent = editMode ? 'Готово' : 'Изменить список';
  $('editBtn').classList.toggle('on', editMode);
  render();
});

document.addEventListener('click', async (e) => {
  const ms = e.target.closest('[data-ms]');
  if (ms) {
    view = ms.dataset.ms;
    sel = null;
    render();
    return;
  }
  const sc = e.target.closest('[data-scope]');
  if (sc) {
    sel = sc.dataset.scope;
    render();
    if (matchMedia('(max-width: 720px)').matches) $('l3h').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const more = e.target.closest('[data-more]');
  if (more) {
    const id = more.dataset.more;
    if (open.has(id)) open.delete(id); else open.add(id);
    renderTasks();
    return;
  }
  const del = e.target.closest('[data-del]');
  if (del) {
    const t = taskById(del.dataset.del);
    if (t && confirm(`Удалить задачу «${t.title}»?`)) {
      try { await api('DELETE', `/api/tasks/${encodeURIComponent(t.id)}`); } catch (err) { toast(err.message); }
    }
  }
});

document.addEventListener('change', async (e) => {
  const c = e.target;
  if (c.matches('.cl .row input[type=checkbox]')) {
    c.checked = !c.checked; // меняем только после подтверждения
    const t = taskById(c.dataset.id);
    if (t) (t.done ? askReopen : askClose)(t);
    return;
  }
  if (c.matches('[data-crit]')) {
    try {
      await api('POST', `/api/tasks/${encodeURIComponent(c.dataset.crit)}/criteria/${c.dataset.i}`, { done: c.checked });
    } catch (err) { c.checked = !c.checked; toast(err.message); }
  }
});

document.addEventListener('submit', async (e) => {
  const f = e.target;
  if (f.id === 'addForm') {
    e.preventDefault();
    const title = f.ttl.value.trim();
    if (!title) { f.ttl.focus(); toast('Введите название задачи'); return; }
    const criteria = f.crit.value.split('\n').map((s) => s.trim()).filter(Boolean);
    try {
      await api('POST', '/api/tasks', { milestone: view, scope: sel, title, weight: Number(f.weight.value), criteria });
      f.reset();
      f.ttl.focus();
    } catch (err) { toast(err.message); }
  }
  if (f.id === 'goalForm') {
    e.preventDefault();
    try {
      await api('PUT', '/api/goal', { title: $('gT').value });
      await api('PUT', '/api/metric', { value: Number($('gM').value || 0) });
      if ($('gA').value !== state.activeMilestone) {
        await api('PUT', '/api/active-milestone', { id: $('gA').value });
        view = $('gA').value;
      }
      $('goalPanel').open = false;
      toast('Сохранено');
    } catch (err) { toast(err.message); }
  }
});

// Живые обновления: изменения с сайта или от Claude через MCP приходят всем сразу.
function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('state', (ev) => {
    const prev = state;
    state = JSON.parse(ev.data);
    $('offline').hidden = true;
    if (pending && !taskById(pending.id)) $('dlg').close();
    if (prev) celebrate(prev); else render();
    if (pending?.mode === 'close') syncCloseBtn();
  });
  es.onerror = () => { $('offline').hidden = false; };
}

initSoundToggle();

api('GET', '/api/state')
  .then((s) => { state = s; render(); })
  .catch(() => { $('offline').hidden = false; })
  .finally(connect);
