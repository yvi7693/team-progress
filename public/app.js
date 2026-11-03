// Клиент дашборда: рисует три уровня (цель → скоупы → задачи)
// и получает обновления от сервера в реальном времени.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let state = null;
let sel = null;
let editMode = false;
let pendingId = null;

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
const tasksOf = (id) => state.tasks.filter((t) => t.scope === id).sort((a, b) => a.createdAt - b.createdAt);

function render() {
  if (!state) return;
  const { goal, scopes, summary } = state;
  document.title = `${goal.title}: ${summary.percent}%`;
  $('goalTitle').textContent = goal.title;
  if (document.activeElement !== $('gT')) $('gT').value = goal.title;
  $('hero').innerHTML = `${summary.percent}<small>%</small>`;
  $('mainbar').setAttribute('aria-label', `Общий прогресс ${summary.percent}%`);
  $('mainbar').innerHTML = summary.scopes
    .map((s) => `<i style="width:${s.share}%;background:${s.color}" title="${esc(s.name)}: ${Math.round(s.share)}% общего прогресса"></i>`)
    .join('');

  if (!sel || !scopeById(sel)) sel = [...summary.scopes].sort((a, b) => a.percent - b.percent)[0]?.id;

  $('scopes').innerHTML = scopes.map((s) => {
    const p = scopeSummary(s.id).percent;
    return `<button class="sc" type="button" data-scope="${esc(s.id)}" aria-pressed="${sel === s.id}">
      <span class="n"><span class="dot" style="background:${s.color}"></span>${esc(s.name)}</span>
      <span class="bar"><i style="width:${p}%;background:${s.color}"></i></span>
      <span class="p">${p}<small>%</small></span></button>`;
  }).join('');

  const scope = scopeById(sel);
  $('l3h').innerHTML = scope ? `<span class="dot" style="background:${scope.color}"></span>Задачи: ${esc(scope.name)}` : 'Задачи';
  const list = scope ? tasksOf(scope.id) : [];
  $('tasks').innerHTML =
    `<ul class="cl">${list.map((t) => `<li class="${t.done ? 'done' : ''}">
      <label><input type="checkbox" data-id="${esc(t.id)}" ${t.done ? 'checked' : ''}><span class="t">${esc(t.title)}</span></label>
      ${editMode ? `<span class="w" title="Вес задачи">вес ${t.weight}</span><button class="del" type="button" data-del="${esc(t.id)}" aria-label="Удалить задачу">×</button>` : ''}
    </li>`).join('')}</ul>` +
    (list.length ? '' : '<p class="empty">В этом скоупе пока нет задач.</p>') +
    (editMode ? `<form class="add" id="addForm">
      <input name="ttl" placeholder="Новая задача" aria-label="Новая задача" maxlength="200">
      <select name="weight" aria-label="Вес задачи"><option value="1">вес 1</option><option value="2" selected>вес 2</option><option value="3">вес 3</option></select>
      <button class="btn" type="submit">Добавить</button></form>` : '');
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
    render();
  });
  es.onerror = () => { $('offline').hidden = false; };
}

api('GET', '/api/state')
  .then((s) => { state = s; render(); })
  .catch(() => { $('offline').hidden = false; })
  .finally(connect);
