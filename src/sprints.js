// Спринты и scrum-метрики. Чистые функции без доступа к файлу: проверка входных
// данных и расчёт. Формулы повторяют таблицу «Fluffy Paw — метрики спринтов»
// (листы «Метрики» и «Как считать»), поэтому числа на сайте совпадают с таблицей.
//
// Спринт: даты, цель, отметка «цель достигнута», основание, критерии приёмки цели
// и карточки. Карточка: вид (План / Добор / Уточнение), SP, результат, рабочий
// день добора, сколько спринтов подряд она в работе.

import { ValidationError } from './errors.js';

export const KINDS = ['План', 'Добор', 'Уточнение'];
export const RESULTS = ['Done', 'Перенос', 'В работе', 'Снята', 'Закрыта без Done'];
export const GOAL_STATUSES = ['', 'Да', 'Частично', 'Нет', 'В процессе'];
export const CRITERION_STATUSES = ['Выполнено', 'В работе', 'Проверить в сборке', 'Нет карточки в спринте'];

// Как считать: тексты из листа «Как считать». Сайт и Claude показывают их рядом с числами.
export const METHOD = {
  goalSuccess: { name: 'Sprint Goal Success Rate', how: 'Доля спринтов с достигнутой целью: «Да» ÷ все завершённые спринты. Главная метрика для гипотезы «появилась конечная цель».', better: 'доля «Да» растёт' },
  velocity: { name: 'Velocity', how: 'Сумма SP карточек, которые дошли до Done за спринт. Только для прогноза следующего планирования; не цель и не сравнение между командами. Мелкая нарезка по 1 SP её раздувает.', better: 'рост (но смотри размер карточек)' },
  throughput: { name: 'Done, карт (Throughput)', how: 'Число карточек в Done за спринт. Не зависит от оценок — проверка velocity.', better: 'рост' },
  sayDo: { name: 'Say/Do', how: 'SP, закрытые из плана, ÷ SP плана. План — состояние доски в конце дня планирования. Добранное в числитель не идёт.', better: 'ближе к 100%' },
  scopeChange: { name: 'Scope Change', how: 'SP добора ÷ SP плана. Добор — карточка, вошедшая в ToDo / In Progress / Review / Done после дня планирования.', better: 'снижение' },
  firstAddDay: { name: 'Первый добор, раб. день', how: 'Рабочий день спринта, в который случился первый добор: 1–5 — первая неделя, 6–10 — вторая. Адаптация под гипотезу о лимите ToDo.', better: 'позже (больше число)' },
  carryOver: { name: 'Carry-over', how: 'SP незакрытых (перенесённых) карточек на конец спринта ÷ весь объём спринта (план + добор + уточнения). Считается после окончания спринта.', better: 'снижение' },
  clarify: { name: 'Уточнение', how: 'Карточка, отрезанная PO от уже взятой, — уточнение плана, не добор. Помечается видом «Уточнение».' },
  estimate: { name: 'Оценки SP', how: 'Из названия карточки (N/M/…): в первом спринте карточки берётся первое число, в каждом следующем — следующее. «a-b» читается как b. Без оценки SP пустой, карточка попадает в «Без оценки».' },
  bounds: { name: 'Границы спринта', how: 'Пн–Пт, две недели. Перемещения выходных относятся к закончившемуся спринту.' },
};


const text = (v, what, max = 300, required = true) => {
  const s = String(v ?? '').trim();
  if (required && !s) throw new ValidationError(`${what} не может быть пустым`);
  if (s.length > max) throw new ValidationError(`${what} длиннее ${max} символов`);
  return s;
};
const oneOf = (v, list, what) => {
  const s = String(v ?? '').trim();
  const hit = list.find((x) => x.toLowerCase() === s.toLowerCase());
  if (hit === undefined) throw new ValidationError(`${what}: «${s}» не подходит. Допустимо: ${list.filter(Boolean).join(', ')}`);
  return hit;
};
const intIn = (v, what, min, max) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new ValidationError(`${what} — целое число от ${min} до ${max}`);
  return n;
};
const isoDate = (v, what) => {
  const s = String(v ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new ValidationError(`${what} в формате ГГГГ-ММ-ДД`);
  return s;
};

export const cleanSprintId = (id) => {
  const s = String(id ?? '').trim();
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(s)) throw new ValidationError('id спринта: латиница, цифры, «-» и «_», до 32 символов (например S9)');
  return s;
};

// SP из названия: «(3/1)» во втором спринте подряд даёт 1, «(2-3)» даёт 3.
// Точка тоже разделитель: «(3.1)» в первом спринте даёт 3.
// Если чисел меньше, чем спринтов подряд, берётся последнее. Нет скобок — null.
export function estimateFromTitle(title, streak = 1) {
  const groups = [...String(title).matchAll(/\(([\d\s/.-]+)\)/g)];
  if (!groups.length) return null;
  // Точка в таблице команды тоже разделяет спринты: «(5/5.3/1)» — это 5, 5, 3, 1.
  const parts = groups.at(-1)[1].split(/[/.]/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const part = parts[Math.min(Math.max(streak, 1), parts.length) - 1];
  const n = Number(part.split('-').at(-1));
  return Number.isFinite(n) ? n : null;
}

const typeFromTitle = (title) => (String(title).match(/^\s*\[([^\]]+)\]/) || [])[1]?.trim() || '';

export function cleanCard(raw, { id, now = Date.now() } = {}) {
  const c = raw || {};
  const title = text(c.title, 'Название карточки', 300);
  const streak = intIn(c.streak, 'Спринт подряд', 1, 50) ?? 1;
  let sp = c.sp;
  if (sp === undefined) sp = estimateFromTitle(title, streak);
  if (sp === '' || sp === null) sp = null;
  else {
    sp = Number(sp);
    if (!Number.isFinite(sp) || sp < 0 || sp > 100) throw new ValidationError('SP — число от 0 до 100 или пусто (без оценки)');
  }
  const kind = oneOf(c.kind ?? 'План', KINDS, 'Вид карточки');
  const addedAt = c.addedAt ? text(c.addedAt, 'Дата добавления', 40) : null;
  return {
    id: id ?? c.id,
    title,
    type: text(c.type ?? typeFromTitle(title), 'Тип', 40, false).toUpperCase(),
    kind,
    sp,
    result: oneOf(c.result ?? 'В работе', RESULTS, 'Результат карточки'),
    addDay: intIn(c.addDay, 'Рабочий день добора', 1, 10),
    addedAt,
    streak,
    note: text(c.note, 'Примечание', 300, false),
    updatedAt: now,
  };
}

export function cleanCriterion(raw) {
  const c = typeof raw === 'string' ? { text: raw } : (raw || {});
  return {
    block: text(c.block, 'Блок критерия', 60, false),
    text: text(c.text, 'Критерий', 300),
    board: text(c.board, 'Что на доске', 400, false),
    status: oneOf(c.status ?? 'В работе', CRITERION_STATUSES, 'Статус критерия'),
  };
}

// Приводит спринты из файла к текущему виду. Неверные записи не роняют загрузку
// дашборда целиком: поля, которые нельзя прочитать, получают значения по умолчанию.
export function normalizeSprints(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list.filter((s) => s && s.id && !seen.has(s.id) && seen.add(s.id)).map((s) => ({
    id: String(s.id),
    start: s.start || '',
    end: s.end || '',
    goal: s.goal || '',
    goalStatus: GOAL_STATUSES.includes(s.goalStatus) ? s.goalStatus : '',
    goalBasis: s.goalBasis || '',
    criteria: Array.isArray(s.criteria) ? s.criteria.filter((c) => c && c.text).map((c) => ({ block: c.block || '', text: c.text, board: c.board || '', status: CRITERION_STATUSES.includes(c.status) ? c.status : 'В работе' })) : [],
    cards: Array.isArray(s.cards) ? s.cards.filter((c) => c && c.title).map((c, i) => ({
      id: c.id || `c${i + 1}`, title: c.title, type: c.type || '', kind: KINDS.includes(c.kind) ? c.kind : 'План',
      sp: typeof c.sp === 'number' ? c.sp : null, result: RESULTS.includes(c.result) ? c.result : 'В работе',
      addDay: Number.isInteger(c.addDay) ? c.addDay : null, addedAt: c.addedAt || null,
      streak: Number.isInteger(c.streak) && c.streak > 0 ? c.streak : 1, note: c.note || '', updatedAt: c.updatedAt || 0,
    })) : [],
  }));
}

export const sprintFields = (patch) => {
  const out = {};
  if (patch.start !== undefined) out.start = isoDate(patch.start, 'Дата начала');
  if (patch.end !== undefined) out.end = isoDate(patch.end, 'Дата конца');
  if (patch.goal !== undefined) out.goal = text(patch.goal, 'Цель спринта', 600, false);
  if (patch.goalStatus !== undefined) out.goalStatus = oneOf(patch.goalStatus, GOAL_STATUSES, 'Цель достигнута');
  if (patch.goalBasis !== undefined) out.goalBasis = text(patch.goalBasis, 'Основание', 600, false);
  if (patch.criteria !== undefined) {
    if (!Array.isArray(patch.criteria) || patch.criteria.length > 20) throw new ValidationError('Критерии цели — список, не больше 20');
    out.criteria = patch.criteria.map(cleanCriterion);
  }
  if (out.start && out.end && out.end < out.start) throw new ValidationError('Конец спринта раньше начала');
  return out;
};

// Метрики одного спринта — те же формулы, что в листе «Метрики».
// null вместо числа значит «не считается» (нет плана или деления на ноль).
export function sprintMetrics(sprint) {
  const cards = sprint.cards || [];
  const sp = (list) => list.reduce((a, c) => a + (c.sp || 0), 0);
  const of = (kind) => cards.filter((c) => c.kind === kind);
  const plan = of('План'), add = of('Добор'), clarify = of('Уточнение');
  const done = cards.filter((c) => c.result === 'Done');
  const carried = cards.filter((c) => c.result === 'Перенос');
  const raw = {
    planCards: plan.length,
    planSP: sp(plan),
    addCards: add.length,
    addSP: sp(add),
    doneFromPlanSP: sp(plan.filter((c) => c.result === 'Done')),
    carryCards: carried.length,
    carrySP: sp(carried),
    inWorkCards: cards.filter((c) => c.result === 'В работе').length,
    clarifySP: sp(clarify),
    unestimatedCards: cards.filter((c) => c.sp === null || c.sp === undefined).length,
    droppedCards: cards.filter((c) => c.result === 'Снята' || c.result === 'Закрыта без Done').length,
    longCards: cards.filter((c) => c.streak >= 2 && c.result !== 'Done').length,
  };
  const hasPlan = raw.planCards > 0;
  const running = raw.inWorkCards > 0;
  const addDays = add.map((c) => c.addDay).filter((d) => Number.isInteger(d));
  const volume = raw.planSP + raw.addSP + raw.clarifySP;
  return {
    ...raw,
    running,
    velocity: hasPlan ? sp(done) : null,
    throughput: hasPlan ? done.length : null,
    sayDo: raw.planSP ? raw.doneFromPlanSP / raw.planSP : null,
    scopeChange: raw.planSP ? raw.addSP / raw.planSP : null,
    // «нет» — добора не было; null — добор есть, но день не указан.
    firstAddDay: !hasPlan ? null : raw.addCards === 0 ? 'нет' : (addDays.length ? Math.min(...addDays) : null),
    // Пока есть карточки «В работе», спринт не закрыт и carry-over не считается.
    carryOver: !hasPlan ? null : running ? 'спринт идёт' : (volume ? raw.carrySP / volume : null),
  };
}

const avg = (list) => {
  const nums = list.filter((x) => typeof x === 'number');
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
};
const round = (x, d = 3) => (typeof x === 'number' ? Math.round(x * 10 ** d) / 10 ** d : x);

const DELTA_KEYS = ['velocity', 'throughput', 'sayDo', 'scopeChange', 'firstAddDay', 'carryOver'];
// Направление улучшения: +1 — лучше, когда больше; -1 — когда меньше.
const BETTER = { velocity: 1, throughput: 1, sayDo: 1, scopeChange: -1, firstAddDay: 1, carryOver: -1 };

// Рабочие дни (Пн–Пт) от today до end включительно.
export function workdaysLeft(end, today) {
  if (!end) return null;
  const d = new Date(`${today}T00:00:00Z`), e = new Date(`${end}T00:00:00Z`);
  let n = 0;
  for (; d <= e; d.setUTCDate(d.getUTCDate() + 1)) if (d.getUTCDay() % 6) n++;
  return n;
}

// Полный отчёт для scrum-мастера и Claude и урезанный — для команды.
// current — активный спринт (или последний), его сравнивают со средним по прошлым.
export function sprintReport(sprints = [], activeId = null, today = new Date().toISOString().slice(0, 10)) {
  const rows = (sprints || []).map((s) => ({ ...s, metrics: sprintMetrics(s) }));
  const current = rows.find((s) => s.id === activeId) || rows.at(-1) || null;
  const past = current ? rows.slice(0, rows.indexOf(current)) : [];
  const judged = past.filter((s) => ['Да', 'Частично', 'Нет'].includes(s.goalStatus));
  const yes = judged.filter((s) => s.goalStatus === 'Да').length;
  const partly = judged.filter((s) => s.goalStatus === 'Частично').length;
  const goalSuccess = { rate: judged.length ? yes / judged.length : null, yes, partly, judged: judged.length };
  const averages = Object.fromEntries(DELTA_KEYS.map((k) => [k, round(avg(past.map((s) => s.metrics[k])))]));
  const deltas = current ? DELTA_KEYS.map((k) => {
    const now = current.metrics[k];
    const base = averages[k];
    const delta = typeof now === 'number' && typeof base === 'number' ? now - base : null;
    return { key: k, name: METHOD[k].name, average: base, current: round(now), delta: round(delta), better: METHOD[k].better, improved: delta === null || delta === 0 ? null : delta * BETTER[k] > 0 };
  }) : [];
  const crit = current?.criteria || [];
  const criteriaDone = crit.filter((c) => c.status === 'Выполнено').length;
  const cur = current && {
    id: current.id, start: current.start, end: current.end, goal: current.goal, goalStatus: current.goalStatus, running: current.metrics.running,
    // Прогресс спринта — Say/Do: SP, закрытые из плана, ÷ SP плана. Добор в него не входит.
    percent: Math.round((current.metrics.sayDo ?? 0) * 100),
    doneSP: current.metrics.doneFromPlanSP, totalSP: current.metrics.planSP,
    workdaysLeft: current.end && today <= current.end ? workdaysLeft(current.end, today < current.start ? current.start : today) : 0,
    criteria: crit.map(({ block, text: t, status }) => ({ block, text: t, status })), criteriaDone, criteriaTotal: crit.length,
  };
  // Команде: цель спринта и основные метрики. Без карточек, оснований и вспомогательных метрик.
  const team = {
    current: cur,
    goalSuccess,
    history: rows.map((s) => ({ id: s.id, goal: s.goal, goalStatus: s.goalStatus, velocity: s.metrics.velocity, throughput: s.metrics.throughput, sayDo: round(s.metrics.sayDo) })),
    main: ['velocity', 'throughput', 'sayDo'].map((k) => {
      const d = deltas.find((x) => x.key === k);
      return { key: k, name: METHOD[k].name, current: d?.current ?? null, average: d?.average ?? null, improved: d?.improved ?? null };
    }),
    sprintsCount: rows.length,
  };
  const full = {
    activeSprint: current?.id ?? null,
    today,
    team,
    current: current && { ...cur, goalBasis: current.goalBasis, criteria: crit, metrics: current.metrics },
    averagesOver: past.map((s) => s.id),
    averages,
    deltas,
    sprints: rows.map((s) => ({ ...s, metrics: Object.fromEntries(Object.entries(s.metrics).map(([k, v]) => [k, round(v)])) })),
    method: METHOD, // правила расчёта — для Claude (get_sprint_metrics), на сайте не показываются
  };
  return { team, full };
}
