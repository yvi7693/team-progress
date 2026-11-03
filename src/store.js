// Хранилище данных дашборда: JSON-файл на диске + кэш в памяти.
// Все изменения проходят через этот модуль, поэтому сайт и MCP-сервер
// всегда видят одно и то же состояние.
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

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

const checkWeight = (w) => {
  const n = Number(w);
  if (!Number.isInteger(n) || n < 1 || n > 3) throw new ValidationError('Вес задачи должен быть целым числом от 1 до 3');
  return n;
};
const cleanTitle = (t, what = 'Название задачи') => {
  const s = String(t ?? '').trim();
  if (!s) throw new ValidationError(`${what} не может быть пустым`);
  if (s.length > 200) throw new ValidationError(`${what} длиннее 200 символов`);
  return s;
};

export function seedState() {
  const now = Date.now();
  return {
    goal: { title: 'Демо к Steam Next Fest' },
    scopes: DEFAULT_SCOPES.map((s) => ({ ...s })),
    tasks: SEED_TASKS.map(([scope, title, weight], i) => ({
      id: randomUUID(), scope, title, weight, done: false, doneAt: null, createdAt: now + i, updatedAt: now + i,
    })),
  };
}

// Прогресс считается по весам задач: закрытый вес / общий вес.
export function summarize(state) {
  const w = (t) => t.weight || 1;
  const sum = (list) => list.reduce((a, t) => a + w(t), 0);
  const total = sum(state.tasks);
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  return {
    percent: pct(sum(state.tasks.filter((t) => t.done)), total),
    tasksTotal: state.tasks.length,
    tasksDone: state.tasks.filter((t) => t.done).length,
    scopes: state.scopes.map((s) => {
      const list = state.tasks.filter((t) => t.scope === s.id);
      const done = sum(list.filter((t) => t.done));
      return {
        id: s.id, name: s.name, color: s.color,
        percent: pct(done, sum(list)),
        // доля скоупа в общем прогрессе (сумма долей = общий процент)
        share: total ? (done / total) * 100 : 0,
        tasksTotal: list.length,
        tasksDone: list.filter((t) => t.done).length,
      };
    }),
  };
}

export class Store extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    this.state = null;
    this.queue = Promise.resolve();
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (!Array.isArray(parsed.tasks) || !Array.isArray(parsed.scopes) || !parsed.goal) {
        throw new Error(`Файл данных ${this.file} повреждён: нет goal, scopes или tasks`);
      }
      this.state = parsed;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      this.state = seedState();
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
      throw new ValidationError(`Неизвестный скоуп «${id}». Доступны: ${this.state.scopes.map((s) => s.id).join(', ')}`);
    }
  }

  #find(id) {
    const t = this.state.tasks.find((x) => x.id === id);
    if (!t) throw new NotFoundError(`Задача ${id} не найдена`);
    return t;
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

  listTasks(scope) {
    if (scope) this.#assertScope(scope);
    return structuredClone(
      this.state.tasks.filter((t) => !scope || t.scope === scope).sort((a, b) => a.createdAt - b.createdAt),
    );
  }

  async addTask({ scope, title, weight = 2 }) {
    this.#assertScope(scope);
    const now = Date.now();
    const task = {
      id: randomUUID(), scope, title: cleanTitle(title), weight: checkWeight(weight),
      done: false, doneAt: null, createdAt: now, updatedAt: now,
    };
    return this.#commit(() => {
      this.state.tasks.push(task);
      return structuredClone(task);
    });
  }

  async updateTask(id, patch = {}) {
    const t = this.#find(id);
    const next = {};
    if (patch.title !== undefined) next.title = cleanTitle(patch.title);
    if (patch.weight !== undefined) next.weight = checkWeight(patch.weight);
    if (patch.scope !== undefined) {
      this.#assertScope(patch.scope);
      next.scope = patch.scope;
    }
    if (patch.done !== undefined) {
      next.done = Boolean(patch.done);
      if (next.done !== t.done) next.doneAt = next.done ? Date.now() : null;
    }
    if (!Object.keys(next).length) throw new ValidationError('Нечего менять: передайте title, weight, scope или done');
    return this.#commit(() => {
      Object.assign(t, next, { updatedAt: Date.now() });
      return structuredClone(t);
    });
  }

  async deleteTask(id) {
    const t = this.#find(id);
    return this.#commit(() => {
      this.state.tasks = this.state.tasks.filter((x) => x.id !== id);
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
}
