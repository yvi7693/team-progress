// Клиент дашборда: главная цель → прогресс активной волны → волны → аспекты выбранной волны → задачи.
// Получает обновления от сервера в реальном времени.
import { calm, countUp, floatPlus, wave, streakHit, milestone, scopeConfetti, shades, closedBadge, showFinale, play, vibrate, initSoundToggle } from './fx.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('ru-RU');

let state = null;
let view = null;        // волна, аспекты которой сейчас смотрят (по умолчанию активная)
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
const justSealed = new Set(); // аспекты активной волны, только что закрытые: блик на главном баре

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
const mainSummary = () => msSummary(state.activeMilestone);
const scopeSummary = (id) => viewSummary().scopes.find((s) => s.id === id);
const tasksOf = (scopeId) => state.tasks
  .filter((t) => t.milestone === view && t.scope === scopeId)
  .sort((a, b) => (a.done && !held.has(a.id)) - (b.done && !held.has(b.id)) || a.createdAt - b.createdAt);
const isClosed = (s) => s.percent === 100 && s.tasksTotal > 0;
const pctHtml = (n) => `${n}<small>%</small>`;
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) : '');

// Главный блок показывает активную волну, аспекты — выбранную; анимации идут от прошлых значений каждого.
function snapshot(main, viewed) {
  return {
    main: main.id, total: main.percent, shares: Object.fromEntries(main.scopes.map((s) => [s.id, s.share])),
    view: viewed.id, scopes: Object.fromEntries(viewed.scopes.map((s) => [s.id, s.percent])),
  };
}

function renderGoal() {
  const { goal } = state;
  $('goalTitle').textContent = goal.title;
  const m = goal.metric || {};
  // Счётчики под баром: показатель цели и продажи. Продаж пока нет — счётчик закрыт до релиза.
  $('metric').innerHTML = `${m.label ? `<div class="stat"><b>${nf.format(m.value || 0)}</b><span>${esc(m.label)}</span></div>` : ''}
    <div class="stat locked" title="Счётчик откроется, когда игра начнёт продаваться">
      <b><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.6"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7"/></svg></b>
      <span>Продажи</span>
    </div>`;
  if (document.activeElement !== $('gT')) $('gT').value = goal.title;
  if (document.activeElement !== $('gM')) $('gM').value = m.value ?? 0;
  $('gMl').textContent = m.label || 'Показатель';
  $('gA').innerHTML = state.milestones.map((x) => `<option value="${esc(x.id)}" ${x.id === state.activeMilestone ? 'selected' : ''}>${esc(x.title)}</option>`).join('');
}

function renderLadder() {
  $('ladder').innerHTML = state.milestones.map((m, i) => {
    const s = msSummary(m.id);
    const status = s.closed ? 'пройдена' : m.id === state.activeMilestone ? 'сейчас' : '';
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
  const main = mainSummary();
  const ms = msById(main.id);
  const sum = viewSummary();
  const fromMain = animate && !calm && shown?.main === main.id ? shown : null;
  const fromView = animate && !calm && shown?.view === view ? shown : null;

  document.title = `${ms.title}: ${main.percent}% — ${state.goal.title}`;
  renderGoal();
  renderLadder();

  // Название и условие — у выбранной волны: они стоят над её аспектами.
  const viewed = msById(view);
  $('msTitle').textContent = viewed.title;
  $('msCriterion').textContent = viewed.criterion || '';
  $('hero').innerHTML = pctHtml(main.percent);
  // Главный бар — весь путь к цели: отрезок на волну шириной по весу её задач,
  // зазор между отрезками — метка волны. Внутри отрезка — прогресс волны цветами аспектов.
  const weightOf = (msId) => state.tasks.filter((t) => t.milestone === msId).reduce((n, t) => n + t.weight, 0);
  const waves = state.summary.milestones.map((m, i) => ({ m, i, w: weightOf(m.id) })).filter((x) => x.w > 0);
  $('mainbar').setAttribute('aria-label', `Прогресс волны «${ms.title}» ${main.percent}%, волн на пути к цели: ${waves.length}`);
  $('mainbar').innerHTML = waves.map(({ m, i, w }) => {
    const active = m.id === main.id;
    const segs = m.scopes.map((s) => {
      const cls = isClosed(s) ? `sealed${active && justSealed.has(s.id) ? ' justsealed' : ''}` : '';
      const from = active ? fromMain?.shares[s.id] : null;
      return `<i class="${cls}" data-w="${s.share}" style="width:${from ?? s.share}%;background:${s.color}" title="${esc(s.name)}: ${Math.round(s.share)}% волны"></i>`;
    }).join('');
    return `<span class="wv${active ? ' active' : ''}${m.closed ? ' done' : ''}" style="flex:${w}" title="${i + 1}. ${esc(msById(m.id).title)}: ${m.percent}%">${segs}</span>`;
  }).join('');
  $('wavemarks').innerHTML = waves.map(({ m, i, w }) =>
    `<span class="${m.id === main.id ? 'active' : ''}${m.closed ? ' done' : ''}" style="flex:${w}">${m.closed ? '✓' : i + 1}</span>`).join('');
  justSealed.clear();

  const withTasks = sum.scopes.filter((s) => s.tasksTotal);
  if (!sel || !scopeById(sel) || !scopeSummary(sel).tasksTotal) sel = [...withTasks].sort((a, b) => a.percent - b.percent)[0]?.id ?? sum.scopes[0]?.id;

  $('scopes').innerHTML = state.scopes.map((s) => {
    const ss = scopeSummary(s.id);
    const p = ss.percent;
    const empty = !ss.tasksTotal;
    const closed = isClosed(ss);
    const cls = ['sc', closed && 'closed', closed && justClosed.has(s.id) && 'justclosed', empty && 'noitems'].filter(Boolean).join(' ');
    const w = fromView?.scopes[s.id] ?? p;
    return `<button class="${cls}" type="button" data-scope="${esc(s.id)}" aria-pressed="${sel === s.id}" style="--c:${s.color}">
      <span class="n"><span class="dot" style="background:${s.color}"></span><span>${esc(s.name)}<small>${empty ? 'в этой волне задач нет' : `${ss.tasksDone} из ${ss.tasksTotal} задач`}</small></span></span>
      <span class="bar"><i data-w="${p}" style="width:${w}%;background:${s.color}"></i></span>
      <span class="p">${empty ? '—' : closed ? closedBadge : pctHtml(p)}</span></button>`;
  }).join('');
  justClosed.clear();

  if (fromMain || fromView) {
    void $('scopes').offsetWidth; // фиксируем старую ширину, чтобы сработал transition
    document.querySelectorAll(`${fromMain ? '#mainbar .wv.active i,' : ''}${fromView ? '#scopes .bar i' : ''}`.replace(/,$/, '')).forEach((i) => { i.style.width = `${i.dataset.w}%`; });
  }
  if (fromMain) countUp($('hero'), fromMain.total, main.percent, { delay: 300, format: pctHtml });
  if (fromView) {
    sum.scopes.forEach((s) => {
      const el = document.querySelector(`.sc[data-scope="${CSS.escape(s.id)}"]:not(.closed):not(.noitems) .p`);
      if (el && fromView.scopes[s.id] != null) countUp(el, fromView.scopes[s.id], s.percent, { format: pctHtml });
    });
  }
  shown = snapshot(main, sum);
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
      // Критерии и зависимости в интерфейсе не показываем; раскрыть можно только, кто принял.
      const hasMore = t.done;
      const details = hasMore && open.has(t.id) ? `<div class="det">
        ${t.done ? `<p class="note"><b>Принято:</b> ${esc(t.acceptedBy)}${t.doneAt ? `, ${fmtDate(t.doneAt)}` : ''}</p>` : ''}
      </div>` : '';
      return `<li class="${cls(t)}" data-task="${esc(t.id)}">
        <div class="row">
          <label><span class="ck"><input type="checkbox" data-id="${esc(t.id)}" ${t.done ? 'checked' : ''}><svg viewBox="0 0 18 18" aria-hidden="true"><path d="M4.5 9.5l3.3 3.1 5.7-6.6"/></svg></span><span class="t">${esc(t.title)}</span></label>
          ${editMode ? `<span class="w" title="Вес задачи">вес ${t.weight}</span><button class="del" type="button" data-del="${esc(t.id)}" aria-label="Удалить задачу">×</button>` : ''}
          ${hasMore ? `<button class="more" type="button" data-more="${esc(t.id)}" aria-expanded="${open.has(t.id)}" aria-label="Подробности задачи">▾</button>` : ''}
        </div>${details}
      </li>`;
    }).join('')}</ul>` +
    (list.length ? '' : '<p class="empty">У этого аспекта в волне пока нет задач.</p>') +
    (editMode ? `<form class="add" id="addForm">
      <div class="addrow">
        <input name="ttl" placeholder="Результат, например «Котики первой волны в финальном арте»" aria-label="Новая задача" maxlength="200">
        <select name="weight" aria-label="Вес задачи"><option value="1">вес 1</option><option value="2" selected>вес 2</option><option value="3">вес 3</option></select>
      </div>
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

// deltas — прирост аспектов выбранной волны; mainScopes и prevTotal — для главного блока (активная волна).
function tasksClosedFx(deltas, mainScopes, count, prevTotal) {
  deltas.forEach((delta, id) => {
    const s = scopeSummary(id);
    const bar = barOf(id);
    if (!bar || delta <= 0) return;
    floatPlus(bar, s.percent, `+${delta}%`, s.color, 150);
    wave(bar, s.percent, s.color, 650);
  });
  const total = mainSummary().percent;
  const activeSeg = () => $('mainbar').querySelector('.wv.active') || $('mainbar');
  mainScopes.forEach((id) => wave(activeSeg(), total, scopeById(id).color, 950));
  const n = streakHit($('hero').querySelector('small') || $('hero'), count);
  play('task', Math.min(n - 1, 6) * 2);
  vibrate('task');
  const crossed = prevTotal != null && [75, 50, 25].find((m) => prevTotal < m && total >= m && total < 100);
  if (crossed) setTimeout(() => milestone($('hero'), activeSeg(), crossed), 1000);
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
    kicker: 'Волна пройдена',
    title: esc(msById(msId).title),
    tasksDone: s.tasksDone,
    scopesDone: withTasks.length,
    scopesTotal: withTasks.length,
    scopesLabel: 'аспектов',
    segments: withTasks.map((x) => ({ color: x.color, share: (weightOf(x.id) / totalW) * 100 })),
  });
}

// Пришло новое состояние: находим закрытые задачи, аспекты и волны и проигрываем эффекты.
function celebrate(prev) {
  const was = (id) => prev.tasks.find((t) => t.id === id);
  const closedTasks = state.tasks.filter((t) => t.done && was(t.id) && !was(t.id).done);
  const justFull = (msId) => {
    const before = prev.summary.milestones.find((m) => m.id === msId);
    const now = msSummary(msId);
    return before && now ? now.scopes.filter((s) => {
      const b = before.scopes.find((x) => x.id === s.id);
      return b && b.percent < 100 && s.percent === 100 && s.tasksTotal;
    }) : [];
  };
  const closedScopes = justFull(view);
  const closedMs = state.summary.milestones.filter((m) => {
    const before = prev.summary.milestones.find((x) => x.id === m.id);
    return before && !before.closed && m.closed;
  });

  const inView = closedTasks.filter((t) => t.milestone === view);
  const inMain = closedTasks.filter((t) => t.milestone === state.activeMilestone);
  const moving = calm ? [] : inView.filter((t) => t.scope === sel).map((t) => t.id);
  moving.forEach((id) => { fresh.add(id); held.add(id); });
  closedScopes.forEach((s) => justClosed.add(s.id));
  justFull(state.activeMilestone).forEach((s) => justSealed.add(s.id));
  const from = shown;
  render(true);

  if (closedTasks.length && from) {
    const deltas = from.view === view
      ? new Map([...new Set(inView.map((t) => t.scope))].map((id) => [id, scopeSummary(id).percent - (from.scopes[id] ?? 0)]))
      : new Map();
    const mainScopes = from.main === state.activeMilestone ? [...new Set(inMain.map((t) => t.scope))] : [];
    tasksClosedFx(deltas, mainScopes, closedTasks.length, from.main === state.activeMilestone ? from.total : null);
  }
  if (moving.length) setTimeout(() => flipTasks(moving), 750);
  closedScopes.forEach((s) => { scopeClosedFx(s.id); toast(`Аспект «${s.name}» в волне закрыт полностью`); });
  closedMs.forEach((m) => setTimeout(() => finale(m.id), closedScopes.length ? 1600 : 900));
}

// Диалог закрытия: нужно только указать, кто принял. Критерии приёмки отмечаются при закрытии сами.
function askClose(t) {
  pending = { id: t.id, mode: 'close' };
  $('dTitle').textContent = 'Закрыть задачу?';
  $('dBody').innerHTML = `<p>«${esc(t.title)}» будет отмечена принятой для всей команды.</p>
    <label class="dl" for="dWho">Кто принял результат</label>
    <input id="dWho" name="who" maxlength="80" autocomplete="name" value="${esc(lsGet('acceptedBy'))}">`;
  $('dOk').textContent = 'Задача принята';
  syncCloseBtn();
  $('dlg').showModal();
  $('dWho').focus();
}

function syncCloseBtn() {
  if (pending?.mode !== 'close') return;
  const t = taskById(pending.id);
  const ok = t && $('dWho')?.value.trim();
  $('dOk').disabled = !ok;
}

function askReopen(t) {
  pending = { id: t.id, mode: 'reopen' };
  $('dTitle').textContent = 'Вернуть задачу в работу?';
  $('dBody').innerHTML = `<p>«${esc(t.title)}» снова станет открытой, и прогресс волны уменьшится. Отметки критериев сохранятся.</p>`;
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
      const checks = t.criteria.map(() => true); // сервер закрывает задачу только с отмеченными критериями
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
  }
});

document.addEventListener('submit', async (e) => {
  const f = e.target;
  if (f.id === 'addForm') {
    e.preventDefault();
    const title = f.ttl.value.trim();
    if (!title) { f.ttl.focus(); toast('Введите название задачи'); return; }
    try {
      await api('POST', '/api/tasks', { milestone: view, scope: sel, title, weight: Number(f.weight.value) });
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
