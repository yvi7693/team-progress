// MCP-сервер: инструменты, через которые Claude читает и меняет задачи и цель.
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
  const server = new McpServer({ name: 'team-progress', version: '1.0.0' });
  const scopeIds = () => store.snapshot().scopes.map((s) => s.id);
  const scopeHint = () => store.snapshot().scopes.map((s) => `${s.id} (${s.name})`).join(', ');
  const weight = z.number().int().min(1).max(3).describe('Вес задачи: 1 — небольшая, 2 — средняя, 3 — крупная');

  server.registerTool('get_dashboard', {
    title: 'Состояние дашборда',
    description: 'Главная цель, общий процент выполнения, процент по каждому скоупу и все задачи. Вызывай первым, чтобы узнать id задач и скоупов.',
    annotations: { readOnlyHint: true },
  }, safe(async () => {
    const s = store.snapshot();
    return json({ goal: s.goal, summary: s.summary, tasks: s.tasks });
  }));

  server.registerTool('list_tasks', {
    title: 'Список задач',
    description: `Задачи одного скоупа или всех сразу. Скоупы: ${scopeHint()}.`,
    inputSchema: { scope: z.string().optional().describe('id скоупа; без него вернутся все задачи') },
    annotations: { readOnlyHint: true },
  }, safe(async ({ scope }) => json(store.listTasks(scope))));

  server.registerTool('add_task', {
    title: 'Добавить задачу',
    description: `Добавляет задачу в скоуп. Скоупы: ${scopeHint()}.`,
    inputSchema: {
      scope: z.string().describe(`id скоупа, один из: ${scopeIds().join(', ')}`),
      title: z.string().min(1).max(200).describe('Название задачи'),
      weight: weight.optional(),
    },
  }, safe(async ({ scope, title, weight: w }) => json(await store.addTask({ scope, title, weight: w ?? 2 }))));

  server.registerTool('update_task', {
    title: 'Изменить задачу',
    description: 'Меняет название, вес или скоуп задачи. Передавай только поля, которые нужно изменить.',
    inputSchema: {
      id: z.string().describe('id задачи из get_dashboard или list_tasks'),
      title: z.string().min(1).max(200).optional(),
      weight: weight.optional(),
      scope: z.string().optional().describe('Перенести задачу в другой скоуп'),
    },
    annotations: { idempotentHint: true },
  }, safe(async ({ id, ...patch }) => json(await store.updateTask(id, patch))));

  server.registerTool('set_task_done', {
    title: 'Закрыть или открыть задачу',
    description: 'Отмечает задачу выполненной (done: true) или возвращает её в работу (done: false). Изменение сразу видит вся команда.',
    inputSchema: { id: z.string(), done: z.boolean() },
    annotations: { idempotentHint: true },
  }, safe(async ({ id, done }) => json(await store.updateTask(id, { done }))));

  server.registerTool('delete_task', {
    title: 'Удалить задачу',
    description: 'Безвозвратно удаляет задачу. Перед вызовом уточни у пользователя, точно ли её нужно удалить.',
    inputSchema: { id: z.string() },
    annotations: { destructiveHint: true },
  }, safe(async ({ id }) => json({ deleted: await store.deleteTask(id) })));

  server.registerTool('set_goal', {
    title: 'Изменить главную цель',
    description: 'Меняет название главной цели команды, которое показано наверху дашборда.',
    inputSchema: { title: z.string().min(1).max(200) },
    annotations: { idempotentHint: true },
  }, safe(async ({ title }) => json(await store.setGoal({ title }))));

  return server;
}
