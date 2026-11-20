// MCP-сервер: инструменты, через которые Claude читает и меняет дашборд.
// Иерархия: главная цель → рубежи → аспекты → задачи с критериями.
// Отдельно — спринты: карточки, цели спринтов и scrum-метрики из них.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { KINDS, RESULTS, GOAL_STATUSES, CRITERION_STATUSES } from './sprints.js';

const json = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });

// Ошибки валидации возвращаем Claude как текст, чтобы он мог исправить запрос.
const safe = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: e.message }] };
  }
};

export function buildMcpServer(store) {
  const server = new McpServer({ name: 'team-progress', version: '1.1.0' });
  const snap = () => store.snapshot();
  const scopeHint = () => snap().scopes.map((s) => `${s.id} (${s.name})`).join(', ');
  const msHint = () => snap().milestones.map((m) => `${m.id} (${m.title})`).join(', ');
  const weight = z.number().int().min(1).max(3).describe('Вес задачи: 1 — короткая или поддерживающая, 2 — обычный результат, 3 — блокер рубежа или многонедельная работа');
  const criteria = z.array(z.string().min(1).max(300)).max(12)
    .describe('Критерии закрытия: 2–6 проверяемых фактов («ассет принят», «работает в билде»). Задача закрывается, только когда отмечены все');

  server.registerTool('get_dashboard', {
    title: 'Состояние дашборда',
    description: 'Главная цель с показателем, рубежи с процентами, аспекты активного рубежа, фразы аспектов и все задачи с критериями и зависимостями. Вызывай первым, чтобы узнать id. Спринты и scrum-метрики — в get_sprint_metrics.',
    annotations: { readOnlyHint: true },
  }, safe(async () => {
    const s = snap();
    return json({ goal: s.goal, activeMilestone: s.activeMilestone, milestones: s.milestones, aims: s.aims, scopes: s.scopes, summary: s.summary, tasks: s.tasks });
  }));

  server.registerTool('list_tasks', {
    title: 'Список задач',
    description: `Задачи с фильтром по рубежу и аспекту. Рубежи: ${msHint()}. Аспекты: ${scopeHint()}.`,
    inputSchema: {
      milestone: z.string().optional().describe('id рубежа'),
      scope: z.string().optional().describe('id аспекта'),
    },
    annotations: { readOnlyHint: true },
  }, safe(async ({ milestone, scope }) => json(store.listTasks({ milestone, scope }))));

  server.registerTool('add_task', {
    title: 'Добавить задачу',
    description: `Добавляет крупную задачу в рубеж и аспект. Рубежи: ${msHint()}. Аспекты: ${scopeHint()}. Без рубежа задача попадает в активный.`,
    inputSchema: {
      scope: z.string().describe('id аспекта'),
      title: z.string().min(1).max(200).describe('Результат, а не действие: «Котики первой волны в финальном арте»'),
      milestone: z.string().optional().describe('id рубежа'),
      weight: weight.optional(),
      criteria: criteria.optional(),
      blocked_by: z.array(z.string()).optional().describe('id задач, от которых зависит эта (справочно: закрыть и вернуть в работу задачу они не мешают)'),
    },
  }, safe(async ({ scope, title, milestone, weight: w, criteria: c, blocked_by: b }) =>
    json(await store.addTask({ scope, title, milestone, weight: w ?? 2, criteria: c, blockedBy: b ?? [] }))));

  server.registerTool('update_task', {
    title: 'Изменить задачу',
    description: 'Меняет название, вес, аспект, рубеж, критерии или зависимости задачи. Передавай только то, что меняется. Новый список критериев заменяет старый; отметки сохраняются у критериев с тем же текстом.',
    inputSchema: {
      id: z.string().describe('id задачи из get_dashboard или list_tasks'),
      title: z.string().min(1).max(200).optional(),
      weight: weight.optional(),
      scope: z.string().optional(),
      milestone: z.string().optional(),
      criteria: criteria.optional(),
      blocked_by: z.array(z.string()).optional(),
    },
    annotations: { idempotentHint: true },
  }, safe(async ({ id, blocked_by: b, ...patch }) => json(await store.updateTask(id, { ...patch, ...(b ? { blockedBy: b } : {}) }))));

  server.registerTool('check_criterion', {
    title: 'Отметить критерий задачи',
    description: 'Отмечает или снимает отметку с одного критерия задачи (index с нуля). Отмечай только то, что пользователь подтвердил как сделанное.',
    inputSchema: { id: z.string(), index: z.number().int().min(0), done: z.boolean() },
    annotations: { idempotentHint: true },
  }, safe(async ({ id, index, done }) => json(await store.checkCriterion(id, index, done))));

  server.registerTool('set_task_done', {
    title: 'Закрыть или открыть задачу',
    description: 'Закрывает задачу (done: true) или возвращает в работу (done: false). Закрытие проходит, только если отмечены все критерии. accepted_by — необязательная пометка, кто принял результат; передавай, только если пользователь сам назвал имя.',
    inputSchema: {
      id: z.string(),
      done: z.boolean(),
      accepted_by: z.string().min(1).max(80).optional().describe('Кто принял результат, необязательно'),
    },
    annotations: { idempotentHint: true },
  }, safe(async ({ id, done, accepted_by: a }) => json(await store.updateTask(id, { done, acceptedBy: a }))));

  server.registerTool('delete_task', {
    title: 'Удалить задачу',
    description: 'Безвозвратно удаляет задачу и убирает её из зависимостей других задач. Перед вызовом уточни у пользователя, точно ли её нужно удалить.',
    inputSchema: { id: z.string() },
    annotations: { destructiveHint: true },
  }, safe(async ({ id }) => json({ deleted: await store.deleteTask(id) })));

  server.registerTool('set_goal', {
    title: 'Изменить главную цель',
    description: 'Меняет формулировку главной цели наверху дашборда.',
    inputSchema: { title: z.string().min(1).max(200) },
    annotations: { idempotentHint: true },
  }, safe(async ({ title }) => json(await store.setGoal({ title }))));

  server.registerTool('set_metric', {
    title: 'Обновить показатель цели',
    description: 'Обновляет показатель главной цели (например, число вишлистов), его название или лестницу ориентиров.',
    inputSchema: {
      value: z.number().min(0).optional(),
      label: z.string().min(1).max(60).optional(),
      ladder: z.array(z.object({ value: z.number().min(0), label: z.string().max(80).optional() })).max(10).optional(),
    },
    annotations: { idempotentHint: true },
  }, safe(async (args) => json(await store.setMetric(args))));

  server.registerTool('add_milestone', {
    title: 'Добавить рубеж',
    description: 'Добавляет рубеж — подцель на пути к главной цели, проверяемую снаружи (страница опубликована, демо живёт).',
    inputSchema: {
      id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).describe('Короткий id латиницей, например demo'),
      title: z.string().min(1).max(120),
      criterion: z.string().max(400).optional().describe('По какому факту рубеж считается взятым'),
      date: z.string().max(80).optional(),
    },
  }, safe(async (args) => json(await store.addMilestone(args))));

  server.registerTool('update_milestone', {
    title: 'Изменить рубеж',
    description: 'Меняет название, критерий или дату рубежа.',
    inputSchema: {
      id: z.string(),
      title: z.string().min(1).max(120).optional(),
      criterion: z.string().max(400).optional(),
      date: z.string().max(80).optional(),
    },
    annotations: { idempotentHint: true },
  }, safe(async ({ id, ...patch }) => json(await store.updateMilestone(id, patch))));

  server.registerTool('set_active_milestone', {
    title: 'Сделать рубеж активным',
    description: 'Активный рубеж показывается крупно, его процент — главный на дашборде. Переключай, когда команда перешла к следующему рубежу.',
    inputSchema: { id: z.string() },
    annotations: { idempotentHint: true },
  }, safe(async ({ id }) => json(await store.setActiveMilestone(id))));

  server.registerTool('set_aim', {
    title: 'Фраза аспекта в рубеже',
    description: 'Задаёт одну фразу: что этот аспект даёт этому рубежу. Пустой текст удаляет фразу.',
    inputSchema: { milestone: z.string(), scope: z.string(), text: z.string().max(200) },
    annotations: { idempotentHint: true },
  }, safe(async ({ milestone, scope, text }) => json(await store.setAim(milestone, scope, text))));

  // ── Спринты и scrum-метрики ────────────────────────────────────────────
  // Метрики сервер пересчитывает сам из карточек при каждом запросе: Claude вносит
  // факты (карточки, цель, статусы), а числа берёт из get_sprint_metrics.
  const sprintHint = () => snap().sprintsTeam.history.map((s) => s.id).join(', ') || 'пока нет';
  const card = {
    title: z.string().min(1).max(300).describe('Название карточки как на доске, с типом и оценкой: «[DESIGN] Вижн игры (3/1)»'),
    kind: z.enum(KINDS).optional().describe('План — была на доске в конце дня планирования; Добор — вошла позже; Уточнение — PO отрезал от уже взятой (не добор). По умолчанию План'),
    sp: z.number().min(0).max(100).nullable().optional().describe('Story points. Не передан — берётся из скобок в названии по правилу оценок; null — без оценки'),
    result: z.enum(RESULTS).optional().describe('Чем карточка кончилась в этом спринте. По умолчанию «В работе»'),
    add_day: z.number().int().min(1).max(10).optional().describe('Для добора: рабочий день спринта (1–10), когда карточку добрали'),
    streak: z.number().int().min(1).max(50).optional().describe('Какой спринт подряд карточка в работе (1 — впервые). Нужен для оценки из названия'),
    type: z.string().max(40).optional().describe('SPIKE, DESIGN, ENABLER, ASSET, CHORE… По умолчанию из [ТЕГА] в названии'),
    added_at: z.string().max(40).optional().describe('Когда карточку добавили в спринт, ISO-дата и время'),
    note: z.string().max(300).optional(),
  };
  const cardIn = ({ add_day: addDay, added_at: addedAt, ...c }) => ({ ...c, ...(addDay !== undefined ? { addDay } : {}), ...(addedAt !== undefined ? { addedAt } : {}) });
  const criterion = z.object({
    block: z.string().max(60).optional().describe('Блок цели: «Мир», «Кекс», «Проверка»'),
    text: z.string().min(1).max(300).describe('Проверяемый факт'),
    board: z.string().max(400).optional().describe('Что на доске по этому критерию'),
    status: z.enum(CRITERION_STATUSES).optional(),
  });

  server.registerTool('get_sprint_metrics', {
    title: 'Метрики спринтов',
    description: 'Полный отчёт scrum-мастера: метрики каждого спринта (Velocity, Throughput, Say/Do, Scope Change, первый добор, Carry-over и исходные суммы), Sprint Goal Success Rate, сравнение активного спринта со средним по прошлым, цели и критерии, правила расчёта (method). С параметром sprint возвращает этот спринт с карточками и их id.',
    inputSchema: { sprint: z.string().optional().describe(`id спринта. Есть: ${sprintHint()}`) },
    annotations: { readOnlyHint: true },
  }, safe(async ({ sprint }) => {
    const full = store.sprintsFull();
    if (!sprint) return json({ ...full, sprints: full.sprints.map(({ cards, ...s }) => ({ ...s, cardsCount: cards.length })) });
    const one = full.sprints.find((s) => s.id === sprint);
    if (!one) throw new Error(`Спринт ${sprint} не найден. Есть: ${sprintHint()}`);
    return json({ sprint: one, method: full.method });
  }));

  server.registerTool('upsert_sprint', {
    title: 'Создать или изменить спринт',
    description: 'Создаёт спринт (нужны id, start, end) или меняет переданные поля существующего: цель, отметку «цель достигнута», основание, критерии цели. cards, если переданы, ЦЕЛИКОМ заменяют карточки спринта — так переносят спринт из таблицы одним вызовом; для правки одной карточки есть add/update/delete_sprint_card. Отметку цели ставь только по решению команды на обзоре спринта.',
    inputSchema: {
      id: z.string().describe('Короткий id: S9'),
      start: z.string().optional().describe('Понедельник начала, ГГГГ-ММ-ДД'),
      end: z.string().optional().describe('Пятница конца, ГГГГ-ММ-ДД'),
      goal: z.string().max(600).optional().describe('Цель спринта: какой результат и зачем'),
      goal_status: z.enum(GOAL_STATUSES).optional().describe('Цель достигнута: Да / Частично / Нет; «В процессе» — спринт идёт'),
      goal_basis: z.string().max(600).optional().describe('Основание оценки цели: из отчёта или обзора спринта'),
      criteria: z.array(criterion).max(20).optional().describe('Критерии приемки цели; заменяют прежние'),
      cards: z.array(z.object(card)).max(300).optional(),
      make_active: z.boolean().optional().describe('Сделать спринт текущим (его цель видит команда)'),
    },
  }, safe(async ({ goal_status: goalStatus, goal_basis: goalBasis, make_active: makeActive, cards, ...rest }) => json(await store.upsertSprint({
    ...rest, goalStatus, goalBasis, makeActive, cards: cards?.map(cardIn),
  }))));

  server.registerTool('set_active_sprint', {
    title: 'Сделать спринт текущим',
    description: 'Текущий спринт показывается команде: его цель и критерии, а метрики сравниваются со средним по предыдущим спринтам.',
    inputSchema: { id: z.string() },
    annotations: { idempotentHint: true },
  }, safe(async ({ id }) => json(await store.setActiveSprint(id))));

  server.registerTool('set_sprint_criterion', {
    title: 'Статус критерия цели спринта',
    description: `Меняет статус (${CRITERION_STATUSES.join(', ')}) и/или «что на доске» у одного критерия цели спринта; index с нуля.`,
    inputSchema: { sprint: z.string(), index: z.number().int().min(0), status: z.enum(CRITERION_STATUSES).optional(), board: z.string().max(400).optional() },
    annotations: { idempotentHint: true },
  }, safe(async ({ sprint, index, status, board }) => json(await store.setSprintCriterion(sprint, index, { status, board }))));

  server.registerTool('add_sprint_card', {
    title: 'Добавить карточку в спринт',
    description: 'Добавляет карточку доски в спринт. Метрики спринта пересчитаются сами.',
    inputSchema: { sprint: z.string(), ...card },
  }, safe(async ({ sprint, ...c }) => json(await store.addCard(sprint, cardIn(c)))));

  server.registerTool('update_sprint_card', {
    title: 'Изменить карточку спринта',
    description: 'Меняет поля карточки (результат, вид, SP, день добора…). id карточки — из get_sprint_metrics с параметром sprint.',
    inputSchema: { sprint: z.string(), card: z.string().describe('id карточки, например c4'), ...Object.fromEntries(Object.entries(card).map(([k, v]) => [k, v.optional()])) },
    annotations: { idempotentHint: true },
  }, safe(async ({ sprint, card: id, ...c }) => json(await store.updateCard(sprint, id, cardIn(c)))));

  server.registerTool('delete_sprint_card', {
    title: 'Удалить карточку спринта',
    description: 'Удаляет карточку из спринта. Перед вызовом уточни у пользователя.',
    inputSchema: { sprint: z.string(), card: z.string() },
    annotations: { destructiveHint: true },
  }, safe(async ({ sprint, card: id }) => json({ deleted: await store.deleteCard(sprint, id) })));

  server.registerTool('delete_sprint', {
    title: 'Удалить спринт',
    description: 'Безвозвратно удаляет спринт со всеми карточками и целью. Перед вызовом уточни у пользователя.',
    inputSchema: { id: z.string() },
    annotations: { destructiveHint: true },
  }, safe(async ({ id }) => json(await store.deleteSprint(id))));

  return server;
}
