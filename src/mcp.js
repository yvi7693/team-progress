// MCP-сервер: инструменты, через которые Claude читает и меняет дашборд.
// Иерархия: главная цель → рубежи → аспекты → задачи с критериями.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

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
    description: 'Главная цель с показателем, рубежи с процентами, аспекты активного рубежа, фразы аспектов и все задачи с критериями и зависимостями. Вызывай первым, чтобы узнать id.',
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
    description: 'Закрывает задачу (done: true) или возвращает в работу (done: false). Закрытие проходит, только если отмечены все критерии и передан accepted_by — кто принял результат. Перед закрытием спроси пользователя, кто принял задачу; не подставляй имя сам.',
    inputSchema: {
      id: z.string(),
      done: z.boolean(),
      accepted_by: z.string().min(1).max(80).optional().describe('Кто принял результат, обязательно при done: true'),
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

  return server;
}
