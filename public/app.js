// Клиент дашборда: рисует три уровня (цель → скоупы → задачи)
// и получает обновления от сервера в реальном времени.
import { calm, countUp, floatPlus, wave, streakHit, milestone, scopeConfetti, shades, closedBadge, showFinale, play, vibrate, initSoundToggle } from './fx.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let state = null;
let sel = null;
let editMode = false;
let pendingId = null;

// Для анимаций: последние показанные числа и одноразовые отметки «только что».
let shown = null;
const fresh = new Set();      // задачи, у которых рисуется галочка
const held = new Set();       // закрытые задачи, которые пока стоят на старом месте
const settling = new Set();   // задачи, уехавшие вниз, подсветка гаснет
const justClosed = new Set(); // скоупы, только что дошедшие до 100%

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t.hideTimer);
  t.hideTimer = setTimeout(() => t.classList.remove('show'), 2400);
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

const scopeById = (id) => state.scopes.find((s) => s.id === id);
const scopeSummary = (id) => state.summary.scopes.find((s) => s.id === id);
// Открытые задачи сверху, закрытые внизу; только что закрытая ненадолго остаётся на месте.
const tasksOf = (id) => state.tasks.filter((t) => t.scope === id).sort((a, b) =>
  (a.done && !held.has(a.id)) - (b.done && !held.has(b.id)) || a.createdAt - b.createdAt);
const isClosed = (s) => s.percent === 100 && s.tasksTotal > 0;
const pctHtml = (n) => `${n}<small>%</small>`;

function snapshot(summary) {
  return { total: summary.percent, scopes: Object.fromEntries(summary.scopes.map((s) => [s.id, { percent: s.percent, share: s.share }])) };
}

// animate: данные изменились, налив и счётчики идут от прошлых значений.
function render(animate = false) {
  if (!state) return;
  const { goal, scopes, summary } = state;
  const from = animate && shown;
  const barFrom = from && !calm ? from : null;
  document.title = `${goal.title}: ${summary.percent}%`;
  $('goalTitle').textContent = goal.title;
  if (document.activeElement !== $('gT')) $('gT').value = goal.title;
  $('hero').innerHTML = pctHtml(summary.percent);
  $('mainbar').setAttribute('aria-label', `Общий прогресс ${summary.percent}%`);
  $('mainbar').innerHTML = summary.scopes.map((s) => {
    const cls = isClosed(s) ? `sealed${justClosed.has(s.id) ? ' justsealed' : ''}` : '';
    const w = barFrom?.scopes[s.id]?.share ?? s.share;
    return `<i class="${cls}" data-w="${s.share}" style="width:${w}%;background:${s.color}" title="${esc(s.name)}: ${Math.round(s.share)}% общего прогресса"></i>`;
  }).join('');

  if (!sel || !scopeById(sel)) sel = [...summary.scopes].sort((a, b) => a.percent - b.percent)[0]?.id;

  $('scopes').innerHTML = scopes.map((s) => {
    const ss = scopeSummary(s.id);
    const p = ss.percent;
    const closed = isClosed(ss);
    const cls = closed ? `sc closed${justClosed.has(s.id) ? ' justclosed' : ''}` : 'sc';
    const w = barFrom?.scopes[s.id]?.percent ?? p;
    return `<button class="${cls}" type="button" data-scope="${esc(s.id)}" aria-pressed="${sel === s.id}" style="--c:${s.color}">
      <span class="n"><span class="dot" style="background:${s.color}"></span>${esc(s.name)}</span>
      <span class="bar"><i data-w="${p}" style="width:${w}%;background:${s.color}"></i></span>
      <span class="p">${closed ? closedBadge : pctHtml(p)}</span></button>`;
  }).join('');
  justClosed.clear();

  if (barFrom) {
    void $('scopes').offsetWidth; // фиксируем старую ширину, чтобы сработал transition
    document.querySelectorAll('#mainbar i, #scopes .bar i').forEach((i) => { i.style.width = `${i.dataset.w}%`; });
  }
  if (from) {
    countUp($('hero'), from.total, summary.percent, { delay: 300, format: pctHtml });
    summary.scopes.forEach((s) => {
      const el = document.querySelector(`.sc[data-scope="${CSS.escape(s.id)}"]:not(.closed) .p`);
      if (el && from.scopes[s.id]) countUp(el, from.scopes[s.id].percent, s.percent, { format: pctHtml });
    });
  }
  shown = snapshot(summary);
  renderTasks();
}

function renderTasks() {
  const scope = scopeById(sel);
  $('l3h').innerHTML = scope ? `<span class="dot" style="background:${scope.color}"></span>Задачи: ${esc(scope.name)}` : 'Задачи';
  const list = scope ? tasksOf(scope.id) : [];
  const cls = (t) => [t.done && 'done', fresh.has(t.id) && 'justdone', settling.has(t.id) && 'settle'].filter(Boolean).join(' ');
  $('tasks').innerHTML =
    `<ul class="cl" style="--c:${scope?.color ?? 'var(--accent)'}">${list.map((t) => `<li class="${cls(t)}" data-task="${esc(t.id)}">
      <label><span class="ck"><input type="checkbox" data-id="${esc(t.id)}" ${t.done ? 'checked' : ''}><svg viewBox="0 0 18 18" aria-hidden="true"><path d="M4.5 9.5l3.3 3.1 5.7-6.6"/></svg></span><span class="t">${esc(t.title)}</span></label>
      ${editMode ? `<span class="w" title="Вес задачи">вес ${t.weight}</span><button class="del" type="button" data-del="${esc(t.id)}" aria-label="Удалить задачу">×</button>` : ''}
    </li>`).join('')}</ul>` +
    (list.length ? '' : '<p class="empty">В этом скоупе пока нет задач.</p>') +
    (editMode ? `<form class="add" id="addForm">
      <input name="ttl" placeholder="Новая задача" aria-label="Новая задача" maxlength="200">
      <select name="weight" aria-label="Вес задачи"><option value="1">вес 1</option><option value="2" selected>вес 2</option><option value="3">вес 3</option></select>
      <button class="btn" type="submit">Добавить</button></form>` : '');
  fresh.clear();
  settling.clear();
}

// Закрытые задачи уезжают вниз: запоминаем позиции, перерисовываем и плавно двигаем (FLIP).
function flipTasks(ids) {
  ids.forEach((id) => { held.delete(id); settling.add(id); });
  const rows = () => [...document.querySelectorAll('.cl li[data-task]')];
  const before = new Map(rows().map((li) => [li.dataset.task, li.getBoundingClientRect().top]));
  renderTasks();
  rows().forEach((li) => {
    const dy = (before.get(li.dataset.task) ?? NaN) - li.getBoundingClientRect().top;
    if (dy) li.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 500, easing: 'cubic-bezier(.2, .7, .2, 1)' });
  });
}

const barOf = (id) => document.querySelector(`.sc[data-scope="${CSS.escape(id)}"] .bar`);

// Отклик на закрытые задачи: вклад, импульс, серия, звук. deltas: скоуп → прирост процентов.
function tasksClosedFx(deltas, count, prevTotal) {
  const total = state.summary.percent;
  deltas.forEach((delta, id) => {
    const s = scopeSummary(id);
    const bar = barOf(id);
    if (!bar || delta <= 0) return;
    floatPlus(bar, s.percent, `+${delta}%`, s.color, 150);
    wave(bar, s.percent, s.color, 650);
    wave($('mainbar'), total, s.color, 950);
  });
  const n = streakHit($('hero').querySelector('small') || $('hero'), count);
  play('task', Math.min(n - 1, 6) * 2); // каждая следующая задача в серии звучит на тон выше
  vibrate('task');
  const crossed = [75, 50, 25].find((m) => prevTotal < m && total >= m && total < 100);
  if (crossed) setTimeout(() => milestone($('hero'), $('mainbar'), crossed), 1000);
}

// Скоуп дошёл до 100%: конфетти из его бара, звук, вибрация.
function scopeClosedFx(id) {
  setTimeout(() => {
    const bar = barOf(id);
    if (bar) scopeConfetti(bar, shades(scopeById(id).color));
    play('scope');
    vibrate('scope');
  }, 650);
}

function finale() {
  const { summary } = state;
  const weightOf = (id) => state.tasks.filter((t) => t.scope === id).reduce((n, t) => n + t.weight, 0);
  const totalW = state.tasks.reduce((n, t) => n + t.weight, 0) || 1;
  showFinale({
    title: esc(state.goal.title),
    tasksDone: summary.tasksDone,
    scopesDone: summary.scopes.filter((s) => s.percent === 100 && s.tasksTotal).length,
    scopesTotal: summary.scopes.length,
    segments: summary.scopes.map((s) => ({ color: s.color, share: (weightOf(s.id) / totalW) * 100 })),
  });
}

// Пришло новое состояние: находим закрытые задачи, скоупы и цель и проигрываем эффекты.
function celebrate(prev) {
  const was = (id) => prev.tasks.find((t) => t.id === id);
  const closedTasks = state.tasks.filter((t) => t.done && was(t.id) && !was(t.id).done);
  const closedScopes = state.summary.scopes.filter((s) => {
    const before = prev.summary.scopes.find((x) => x.id === s.id);
    return before && before.percent < 100 && s.percent === 100 && s.tasksTotal;
  });
  const goalDone = prev.summary.percent < 100 && state.summary.percent === 100;

  const moving = calm ? [] : closedTasks.filter((t) => t.scope === sel).map((t) => t.id);
  moving.forEach((id) => { fresh.add(id); held.add(id); });
  closedScopes.forEach((s) => justClosed.add(s.id));
  const from = shown;
  render(true);

  if (closedTasks.length && from) {
    const deltas = new Map([...new Set(closedTasks.map((t) => t.scope))].map((id) => [id, scopeSummary(id).percent - (from.scopes[id]?.percent ?? 0)]));
    tasksClosedFx(deltas, closedTasks.length, from.total);
  }
  if (moving.length) setTimeout(() => flipTasks(moving), 750);
  closedScopes.forEach((s) => scopeClosedFx(s.id));
  if (goalDone) setTimeout(finale, closedScopes.length ? 1600 : 900);
}

function ask(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  pendingId = id;
  $('dTitle').textContent = t.done ? 'Вернуть задачу в работу?' : 'Закрыть задачу?';
  $('dText').textContent = t.done
    ? `«${t.title}» снова станет открытой, и прогресс уменьшится.`
    : `«${t.title}» будет отмечена выполненной для всей команды. Закрывайте, только если задача полностью готова.`;
  $('dOk').textContent = t.done ? 'Вернуть в работу' : 'Да, задача готова';
  $('dlg').showModal();
}

$('dOk').addEventListener('click', async () => {
  $('dlg').close();
  const t = state.tasks.find((x) => x.id === pendingId);
  pendingId = null;
  if (!t) return;
  try {
    await api('PATCH', `/api/tasks/${encodeURIComponent(t.id)}`, { done: !t.done });
    if (!t.done) toast('Задача закрыта');
  } catch (e) { toast(e.message); }
});
$('dNo').addEventListener('click', () => { $('dlg').close(); pendingId = null; });

$('editBtn').addEventListener('click', () => {
  editMode = !editMode;
  $('editBtn').textContent = editMode ? 'Готово' : 'Изменить список';
  $('editBtn').classList.toggle('on', editMode);
  render();
});

document.addEventListener('click', async (e) => {
  const sc = e.target.closest('[data-scope]');
  if (sc) {
    sel = sc.dataset.scope;
    render();
    if (matchMedia('(max-width: 720px)').matches) $('l3h').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const del = e.target.closest('[data-del]');
  if (del) {
    const t = state.tasks.find((x) => x.id === del.dataset.del);
    if (t && confirm(`Удалить задачу «${t.title}»?`)) {
      try { await api('DELETE', `/api/tasks/${encodeURIComponent(t.id)}`); } catch (err) { toast(err.message); }
    }
  }
});

document.addEventListener('change', (e) => {
  const c = e.target;
  if (c.matches('.cl input[type=checkbox]')) {
    c.checked = !c.checked; // меняем только после подтверждения
    ask(c.dataset.id);
  }
});

document.addEventListener('submit', async (e) => {
  const f = e.target;
  if (f.id === 'addForm') {
    e.preventDefault();
    const title = f.ttl.value.trim();
    if (!title) { f.ttl.focus(); toast('Введите название задачи'); return; }
    try {
      await api('POST', '/api/tasks', { scope: sel, title, weight: Number(f.weight.value) });
      f.ttl.value = '';
      f.ttl.focus();
    } catch (err) { toast(err.message); }
  }
  if (f.id === 'goalForm') {
    e.preventDefault();
    try {
      await api('PUT', '/api/goal', { title: $('gT').value });
      $('goalPanel').open = false;
      toast('Цель сохранена');
    } catch (err) { toast(err.message); }
  }
});

// Живые обновления: изменения с сайта или от Claude через MCP приходят всем сразу.
function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('state', (ev) => {
    const prev = state;
    state = JSON.parse(ev.data);
    // Скоуп только что дошёл до 100% — сообщаем всем, у кого открыт дашборд.
    if (prev) {
      state.summary.scopes.forEach((s) => {
        const before = prev.summary.scopes.find((x) => x.id === s.id);
        if (before && before.percent < 100 && s.percent === 100 && s.tasksTotal) toast(`Скоуп «${s.name}» закрыт полностью`);
      });
    }
    $('offline').hidden = true;
    if (prev) celebrate(prev); else render();
  });
  es.onerror = () => { $('offline').hidden = false; };
}

initSoundToggle();

api('GET', '/api/state')
  .then((s) => { state = s; render(); })
  .catch(() => { $('offline').hidden = false; })
  .finally(connect);
