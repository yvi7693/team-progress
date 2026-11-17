// Хранилище данных дашборда: JSON-файл на диске + кэш в памяти.
// Все изменения проходят через этот модуль, поэтому сайт и MCP-сервер
// всегда видят одно и то же состояние.
//
// Иерархия: главная цель → рубежи (подцели) → аспекты (скоупы) → задачи.
// Задача закрывается, только когда отмечены все её критерии, закрыты все
// задачи, от которых она зависит, и указано, кто принял результат.
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const SCHEMA_VERSION = 2;

export const DEFAULT_SCOPES = [
  { id: 'art', name: 'Арт', color: '#8E4FE0' },
  { id: 'tech', name: 'Технологии', color: '#00908F' },
  { id: 'code', name: 'Программирование', color: '#E2602D' },
  { id: 'design', name: 'Геймдизайн', color: '#D63A70' },
  { id: 'mkt', name: 'Маркетинг', color: '#2A72D8' },
];

const SEED_TASKS = [
  ['art', 'Стайлгайд и референсы', 2], ['art', 'Концепт главного героя', 2], ['art', 'Спрайты / модель героя', 3],
  ['art', 'Анимации героя', 3], ['art', 'Окружение уровня демо', 3], ['art', 'UI-иконки и шрифты', 1],
  ['tech', 'Версия Unity и структура проекта', 1], ['tech', 'Git + LFS, правила веток', 1], ['tech', 'Автосборка (CI)', 2],
  ['tech', 'Интеграция Steamworks SDK', 2], ['tech', 'Профилирование и оптимизация', 2],
  ['code', 'Контроллер персонажа', 3], ['code', 'Кор-механика', 3], ['code', 'Меню и UI', 2],
  ['code', 'Сохранения', 2], ['code', 'Звук в игре', 1], ['code', 'Багфикс и полировка', 2],
  ['design', 'GDD и кор-луп', 2], ['design', 'Дизайн уровня демо', 3], ['design', 'Туториал', 2],
  ['design', 'Баланс', 2], ['design', 'Плейтест с внешними игроками', 2],
  ['mkt', 'Страница в Steam', 2], ['mkt', 'Discord-сервер', 1], ['mkt', 'Контент-план соцсетей', 1],
  ['mkt', 'Трейлер демо', 3], ['mkt', 'Пресс-кит', 1], ['mkt', 'Регистрация на Next Fest', 1],
];

export class ValidationError extends Error {}
export class NotFoundError extends Error {}

const MAX_CRITERIA = 12;

const checkWeight = (w) => {
  const n = Number(w);
  if (!Number.isInteger(n) || n < 1 || n > 3) throw new ValidationError('Вес задачи должен быть целым числом от 1 до 3');
  return n;
};
const cleanText = (t, what, max = 200) => {
  const s = String(t ?? '').trim();
  if (!s) throw new ValidationError(`${what} не может быть пустым`);
  if (s.length > max) throw new ValidationError(`${what} длиннее ${max} символов`);
  return s;
};
const cleanTitle = (t, what = 'Название задачи') => cleanText(t, what);
const optText = (t, max = 400) => {
  const s = String(t ?? '').trim();
  if (s.length > max) throw new ValidationError(`Текст длиннее ${max} символов`);
  return s;
};
const cleanId = (id, what) => {
  const s = String(id ?? '').trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(s)) throw new ValidationError(`${what}: допустимы латиница, цифры, «-» и «_», до 64 символов`);
  return s;
};
// Критерии приходят строками или объектами { text, done }.
const cleanCriteria = (list) => {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new ValidationError('Критерии передаются списком');
  if (list.length > MAX_CRITERIA) throw new ValidationError(`Не больше ${MAX_CRITERIA} критериев у задачи`);
  return list.map((c) => {
    const obj = typeof c === 'string' ? { text: c } : (c || {});
    return { text: cleanText(obj.text, 'Критерий', 300), done: Boolean(obj.done) };
  });
};

function defaultMetric() {
  return { label: 'Вишлисты', value: 0, ladder: [] };
}

export function seedState() {
  const now = Date.now();
  return {
    version: SCHEMA_VERSION,
    goal: { title: 'Игра в Steam, и её покупают', metric: defaultMetric() },
    milestones: [{ id: 'demo', title: 'Демо к Steam Next Fest', criterion: '', date: '' }],
    activeMilestone: 'demo',
    aims: {},
    scopes: DEFAULT_SCOPES.map((s) => ({ ...s })),
    tasks: SEED_TASKS.map(([scope, title, weight], i) => ({
      id: randomUUID(), milestone: 'demo', scope, title, weight, criteria: [], blockedBy: [],
      done: false, doneAt: null, acceptedBy: null, createdAt: now + i, updatedAt: now + i,
    })),
  };
}

// Приводит файл любой версии к текущей схеме. Старые файлы (без рубежей)
// получают один рубеж «Текущий рубеж», в который попадают все задачи.
export function normalize(raw) {
  if (!raw || !Array.isArray(raw.tasks) || !Array.isArray(raw.scopes) || !raw.goal) {
    throw new Error('Файл данных повреждён: нет goal, scopes или tasks');
  }
  const now = Date.now();
  const s = structuredClone(raw);
  s.goal = { title: cleanTitle(s.goal.title, 'Название цели'), metric: { ...defaultMetric(), ...(s.goal.metric || {}) } };
  if (!Array.isArray(s.goal.metric.ladder)) s.goal.metric.ladder = [];
  if (!Array.isArray(s.milestones) || !s.milestones.length) {
    s.milestones = [{ id: 'current', title: 'Текущий рубеж', criterion: '', date: '' }];
  }
  s.milestones = s.milestones.map((m) => ({ id: m.id, title: m.title, criterion: m.criterion || '', date: m.date || '' }));
  const msIds = new Set(s.milestones.map((m) => m.id));
  if (!msIds.has(s.activeMilestone)) s.activeMilestone = s.milestones[0].id;
  s.aims = s.aims && typeof s.aims === 'object' ? s.aims : {};
  s.tasks = s.tasks.map((t, i) => ({
    id: t.id || randomUUID(),
    milestone: msIds.has(t.milestone) ? t.milestone : s.milestones[0].id,
    scope: t.scope,
    title: t.title,
    weight: t.weight || 1,
    criteria: cleanCriteria(t.criteria),
    blockedBy: Array.isArray(t.blockedBy) ? t.blockedBy : [],
    done: Boolean(t.done),
    doneAt: t.done ? (t.doneAt || now) : null,
    acceptedBy: t.done ? (t.acceptedBy || null) : null,
    createdAt: t.createdAt || now + i,
    updatedAt: t.updatedAt || now + i,
  }));
  const taskIds = new Set(s.tasks.map((t) => t.id));
  s.tasks.forEach((t) => { t.blockedBy = t.blockedBy.filter((id) => taskIds.has(id) && id !== t.id); });
  s.version = SCHEMA_VERSION;
  return s;
}

// Прогресс считается по весам закрытых задач. Отмеченные критерии
// в процент не входят: бар двигается только принятым результатом.
export function summarize(state) {
  const w = (t) => t.weight || 1;
  const sum = (list) => list.reduce((a, t) => a + w(t), 0);
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const byId = new Map(state.tasks.map((t) => [t.id, t]));

  const milestones = state.milestones.map((m) => {
    const list = state.tasks.filter((t) => t.milestone === m.id);
    const total = sum(list);
    const doneW = sum(list.filter((t) => t.done));
    return {
      id: m.id,
      title: m.title,
      percent: pct(doneW, total),
      tasksTotal: list.length,
      tasksDone: list.filter((t) => t.done).length,
      closed: list.length > 0 && list.every((t) => t.done),
      active: m.id === state.activeMilestone,
      scopes: state.scopes.map((s) => {
        const sl = list.filter((t) => t.scope === s.id);
        const done = sum(sl.filter((t) => t.done));
        return {
          id: s.id, name: s.name, color: s.color,
          percent: pct(done, sum(sl)),
          // доля аспекта в проценте рубежа (сумма долей = процент рубежа)
          share: total ? (done / total) * 100 : 0,
          tasksTotal: sl.length,
          tasksDone: sl.filter((t) => t.done).length,
        };
      }),
    };
  });

  const active = milestones.find((m) => m.active) || milestones[0];
  const blockersOpen = Object.fromEntries(state.tasks.map((t) => [t.id, t.blockedBy.filter((id) => !byId.get(id)?.done)]));
  return {
    activeMilestone: active?.id ?? null,
    percent: active?.percent ?? 0,
    tasksTotal: active?.tasksTotal ?? 0,
    tasksDone: active?.tasksDone ?? 0,
    scopes: active?.scopes ?? [],
    milestones,
    blockersOpen,
  };
}

export class Store extends EventEmitter {
  constructor(file, { seedFile } = {}) {
    super();
    this.file = file;
    this.seedFile = seedFile;
    this.state = null;
    this.queue = Promise.resolve();
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      try {
        this.state = normalize(parsed);
      } catch (e) {
        throw new Error(`Файл данных ${this.file}: ${e.message}`);
      }
      if (parsed.version !== SCHEMA_VERSION) await this.#write();
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      this.state = this.seedFile ? await loadSeedFile(this.seedFile) : seedState();
      await this.#write();
    }
    return this;
  }

  snapshot() {
    const s = structuredClone(this.state);
    return { ...s, summary: summarize(s) };
  }

  #assertScope(id) {
    if (!this.state.scopes.some((s) => s.id === id)) {
      throw new ValidationError(`Неизвестный аспект «${id}». Доступны: ${this.state.scopes.map((s) => s.id).join(', ')}`);
    }
  }

  #assertMilestone(id) {
    if (!this.state.milestones.some((m) => m.id === id)) {
      throw new ValidationError(`Неизвестный рубеж «${id}». Доступны: ${this.state.milestones.map((m) => m.id).join(', ')}`);
    }
  }

  #find(id) {
    const t = this.state.tasks.find((x) => x.id === id);
    if (!t) throw new NotFoundError(`Задача ${id} не найдена`);
    return t;
  }

  #findMilestone(id) {
    const m = this.state.milestones.find((x) => x.id === id);
    if (!m) throw new NotFoundError(`Рубеж ${id} не найден`);
    return m;
  }

  // Проверяет зависимости: задачи существуют, нет ссылки на себя и нет цикла.
  #checkBlockers(taskId, list) {
    if (!Array.isArray(list)) throw new ValidationError('Зависимости передаются списком id задач');
    const ids = [...new Set(list.map(String))];
    for (const id of ids) {
      if (id === taskId) throw new ValidationError('Задача не может зависеть от самой себя');
      this.#find(id);
    }
    const graph = new Map(this.state.tasks.map((t) => [t.id, t.blockedBy]));
    graph.set(taskId, ids);
    const seen = new Set();
    const stack = [...ids];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === taskId) throw new ValidationError('Зависимости образуют цикл');
      if (seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...(graph.get(cur) || []));
    }
    return ids;
  }

  #dependents(id) {
    return this.state.tasks.filter((t) => t.blockedBy.includes(id));
  }

  // Записи идут строго по очереди, чтобы параллельные запросы не перетёрли файл.
  #commit(mutate) {
    const run = async () => {
      const result = mutate();
      await this.#write();
      this.emit('change', this.snapshot());
      return result;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async #write() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.state, null, 2));
    await fs.rename(tmp, this.file);
  }

  listTasks({ scope, milestone } = {}) {
    if (scope) this.#assertScope(scope);
    if (milestone) this.#assertMilestone(milestone);
    return structuredClone(
      this.state.tasks
        .filter((t) => (!scope || t.scope === scope) && (!milestone || t.milestone === milestone))
        .sort((a, b) => a.createdAt - b.createdAt),
    );
  }

  async addTask({ scope, title, weight = 2, milestone, criteria, blockedBy = [], id }) {
    this.#assertScope(scope);
    const ms = milestone ?? this.state.activeMilestone;
    this.#assertMilestone(ms);
    const taskId = id ? cleanId(id, 'id задачи') : randomUUID();
    if (this.state.tasks.some((t) => t.id === taskId)) throw new ValidationError(`Задача с id «${taskId}» уже есть`);
    const now = Date.now();
    const task = {
      id: taskId, milestone: ms, scope, title: cleanTitle(title), weight: checkWeight(weight),
      criteria: cleanCriteria(criteria).map((c) => ({ ...c, done: false })),
      blockedBy: this.#checkBlockers(taskId, blockedBy),
      done: false, doneAt: null, acceptedBy: null, createdAt: now, updatedAt: now,
    };
    return this.#commit(() => {
      this.state.tasks.push(task);
      return structuredClone(task);
    });
  }

  // Меняет поля задачи. Закрытие (done: true) проходит три проверки:
  // все критерии отмечены, все зависимости закрыты, указано, кто принял.
  // checks — необязательный список отметок критериев, применяется до проверки.
  async updateTask(id, patch = {}) {
    const t = this.#find(id);
    const next = {};
    if (patch.title !== undefined) next.title = cleanTitle(patch.title);
    if (patch.weight !== undefined) next.weight = checkWeight(patch.weight);
    if (patch.scope !== undefined) {
      this.#assertScope(patch.scope);
      next.scope = patch.scope;
    }
    if (patch.milestone !== undefined) {
      this.#assertMilestone(patch.milestone);
      next.milestone = patch.milestone;
    }
    if (patch.blockedBy !== undefined) next.blockedBy = this.#checkBlockers(t.id, patch.blockedBy);
    if (patch.criteria !== undefined) {
      if (t.done) throw new ValidationError('Критерии закрытой задачи не меняются — сначала верните её в работу');
      // Отметки сохраняются у критериев, текст которых не изменился.
      const was = new Map(t.criteria.map((c) => [c.text, c.done]));
      next.criteria = cleanCriteria(patch.criteria).map((c) => ({ text: c.text, done: was.get(c.text) ?? false }));
    }
    if (patch.checks !== undefined) {
      const base = next.criteria ?? t.criteria;
      if (!Array.isArray(patch.checks) || patch.checks.length !== base.length) {
        throw new ValidationError(`Отметок должно быть столько же, сколько критериев (${base.length})`);
      }
      if (t.done && patch.checks.some((c) => !c)) throw new ValidationError('У закрытой задачи нельзя снять отметку — сначала верните её в работу');
      next.criteria = base.map((c, i) => ({ ...c, done: Boolean(patch.checks[i]) }));
    }

    if (patch.done !== undefined && Boolean(patch.done) !== t.done) {
      if (patch.done) {
        const criteria = next.criteria ?? t.criteria;
        const open = criteria.filter((c) => !c.done);
        if (open.length) throw new ValidationError(`Не отмечены критерии: ${open.map((c) => `«${c.text}»`).join(', ')}`);
        const blockers = (next.blockedBy ?? t.blockedBy).map((b) => this.#find(b)).filter((b) => !b.done);
        if (blockers.length) throw new ValidationError(`Сначала должны быть закрыты: ${blockers.map((b) => `«${b.title}»`).join(', ')}`);
        next.acceptedBy = cleanText(patch.acceptedBy, 'Кто принял задачу', 80);
        next.done = true;
        next.doneAt = Date.now();
      } else {
        const deps = this.#dependents(t.id).filter((d) => d.done);
        if (deps.length) throw new ValidationError(`От этой задачи зависят закрытые: ${deps.map((d) => `«${d.title}»`).join(', ')}. Сначала верните их в работу`);
        next.done = false;
        next.doneAt = null;
        next.acceptedBy = null;
      }
    }

    if (!Object.keys(next).length) throw new ValidationError('Нечего менять: передайте title, weight, scope, milestone, criteria, checks, blockedBy или done');
    return this.#commit(() => {
      Object.assign(t, next, { updatedAt: Date.now() });
      return structuredClone(t);
    });
  }

  async checkCriterion(id, index, done) {
    const t = this.#find(id);
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= t.criteria.length) throw new ValidationError(`У задачи нет критерия №${index}`);
    if (t.done && !done) throw new ValidationError('У закрытой задачи нельзя снять отметку — сначала верните её в работу');
    const checks = t.criteria.map((c, n) => (n === i ? Boolean(done) : c.done));
    return this.updateTask(id, { checks });
  }

  async deleteTask(id) {
    const t = this.#find(id);
    return this.#commit(() => {
      this.state.tasks = this.state.tasks.filter((x) => x.id !== id);
      this.state.tasks.forEach((x) => { x.blockedBy = x.blockedBy.filter((b) => b !== id); });
      return structuredClone(t);
    });
  }

  async setGoal({ title }) {
    const clean = cleanTitle(title, 'Название цели');
    return this.#commit(() => {
      this.state.goal = { ...this.state.goal, title: clean };
      return structuredClone(this.state.goal);
    });
  }

  // Показатель главной цели (например, вишлисты) и его лестница ориентиров.
  async setMetric({ value, label, ladder }) {
    const next = { ...this.state.goal.metric };
    if (value !== undefined) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) throw new ValidationError('Значение показателя — неотрицательное число');
      next.value = Math.round(n);
    }
    if (label !== undefined) next.label = cleanText(label, 'Название показателя', 60);
    if (ladder !== undefined) {
      if (!Array.isArray(ladder) || ladder.length > 10) throw new ValidationError('Лестница — список до 10 ступеней');
      next.ladder = ladder.map((s) => {
        const v = Number(s?.value);
        if (!Number.isFinite(v) || v < 0) throw new ValidationError('Ступень лестницы — неотрицательное число');
        return { value: Math.round(v), label: optText(s?.label, 80) };
      }).sort((a, b) => a.value - b.value);
    }
    return this.#commit(() => {
      this.state.goal = { ...this.state.goal, metric: next };
      return structuredClone(next);
    });
  }

  async addMilestone({ id, title, criterion = '', date = '' }) {
    const mid = cleanId(id, 'id рубежа');
    if (this.state.milestones.some((m) => m.id === mid)) throw new ValidationError(`Рубеж «${mid}» уже есть`);
    const m = { id: mid, title: cleanText(title, 'Название рубежа', 120), criterion: optText(criterion), date: optText(date, 80) };
    return this.#commit(() => {
      this.state.milestones.push(m);
      return structuredClone(m);
    });
  }

  async updateMilestone(id, { title, criterion, date }) {
    const m = this.#findMilestone(id);
    const next = {};
    if (title !== undefined) next.title = cleanText(title, 'Название рубежа', 120);
    if (criterion !== undefined) next.criterion = optText(criterion);
    if (date !== undefined) next.date = optText(date, 80);
    if (!Object.keys(next).length) throw new ValidationError('Нечего менять: передайте title, criterion или date');
    return this.#commit(() => {
      Object.assign(m, next);
      return structuredClone(m);
    });
  }

  async setActiveMilestone(id) {
    this.#findMilestone(id);
    return this.#commit(() => {
      this.state.activeMilestone = id;
      return { activeMilestone: id };
    });
  }

  async deleteMilestone(id) {
    this.#findMilestone(id);
    if (this.state.tasks.some((t) => t.milestone === id)) throw new ValidationError('В рубеже есть задачи — сначала перенесите или удалите их');
    if (this.state.milestones.length === 1) throw new ValidationError('Нельзя удалить единственный рубеж');
    return this.#commit(() => {
      this.state.milestones = this.state.milestones.filter((m) => m.id !== id);
      delete this.state.aims[id];
      if (this.state.activeMilestone === id) this.state.activeMilestone = this.state.milestones[0].id;
      return { deleted: id };
    });
  }

  // Фраза аспекта в рубеже: что этот аспект даёт рубежу. Пустой текст удаляет фразу.
  async setAim(milestone, scope, text) {
    this.#assertMilestone(milestone);
    this.#assertScope(scope);
    const clean = optText(text, 200);
    return this.#commit(() => {
      const aims = this.state.aims[milestone] || (this.state.aims[milestone] = {});
      if (clean) aims[scope] = clean; else delete aims[scope];
      return { milestone, scope, aim: clean };
    });
  }
}

// Файл начального плана: та же схема, что и db.json. id задач и рубежей сохраняются,
// поэтому зависимости в плане можно задавать короткими понятными id.
export async function loadSeedFile(file) {
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  const now = Date.now();
  raw.tasks = (raw.tasks || []).map((t, i) => ({ createdAt: now + i, updatedAt: now + i, ...t }));
  const s = normalize(raw);
  const missing = s.tasks.flatMap((t) => (raw.tasks.find((r) => r.id === t.id)?.blockedBy || []).filter((b) => !t.blockedBy.includes(b)));
  if (missing.length) throw new Error(`В плане ${file} есть зависимости на несуществующие задачи: ${missing.join(', ')}`);
  for (const t of s.tasks) {
    if (!s.scopes.some((sc) => sc.id === t.scope)) throw new Error(`В плане ${file} у задачи «${t.id}» неизвестный аспект «${t.scope}»`);
    if (t.done && t.criteria.some((c) => !c.done)) throw new Error(`В плане ${file} задача «${t.id}» закрыта, но не все её критерии отмечены`);
    if (t.done && !t.acceptedBy) throw new Error(`В плане ${file} у закрытой задачи «${t.id}» не указано, кто принял`);
    const open = t.done && t.blockedBy.filter((b) => !s.tasks.find((x) => x.id === b).done);
    if (open?.length) throw new Error(`В плане ${file} задача «${t.id}» закрыта раньше задач, от которых зависит: ${open.join(', ')}`);
  }
  return s;
}
