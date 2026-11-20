import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';

async function start(opts = {}) {
  const store = await new Store(path.join(await mkdtemp(path.join(tmpdir(), 'tp-')), 'db.json')).load();
  const server = createApp(store, opts).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { store, server, base: `http://127.0.0.1:${server.address().port}` };
}

async function connect(url) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}
const parse = (r) => JSON.parse(r.content[0].text);

test('Claude через MCP видит дашборд и меняет задачи и цель', async () => {
  const { store, server, base } = await start();
  const client = await connect(`${base}/mcp`);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['add_milestone', 'add_sprint_card', 'add_task', 'check_criterion', 'delete_sprint', 'delete_sprint_card', 'delete_task', 'get_dashboard', 'get_sprint_metrics', 'list_tasks', 'set_active_milestone', 'set_active_sprint', 'set_aim', 'set_goal', 'set_metric', 'set_sprint_criterion', 'set_task_done', 'update_milestone', 'update_sprint_card', 'update_task', 'upsert_sprint']);

    const added = parse(await client.callTool({ name: 'add_task', arguments: { scope: 'design', title: 'Нарратив', weight: 2, criteria: ['Текст написан'] } }));
    assert.equal(added.scope, 'design');
    const early = await client.callTool({ name: 'set_task_done', arguments: { id: added.id, done: true, accepted_by: 'PO' } });
    assert.equal(early.isError, true); // критерий не отмечен
    await client.callTool({ name: 'check_criterion', arguments: { id: added.id, index: 0, done: true } });
    await client.callTool({ name: 'set_task_done', arguments: { id: added.id, done: true, accepted_by: 'PO' } });
    await client.callTool({ name: 'update_task', arguments: { id: added.id, title: 'Нарратив и диалоги' } });
    await client.callTool({ name: 'set_goal', arguments: { title: 'Вертикальный срез' } });
    await client.callTool({ name: 'add_milestone', arguments: { id: 'page', title: 'Страница в Steam', date: '28.11' } });
    await client.callTool({ name: 'set_aim', arguments: { milestone: 'page', scope: 'mkt', text: 'Страница опубликована' } });
    await client.callTool({ name: 'set_metric', arguments: { value: 42 } });

    const dash = parse(await client.callTool({ name: 'get_dashboard', arguments: {} }));
    assert.equal(dash.goal.title, 'Вертикальный срез');
    const t = dash.tasks.find((x) => x.id === added.id);
    assert.equal(t.title, 'Нарратив и диалоги');
    assert.equal(t.done, true);
    assert.ok(dash.summary.percent > 0);
    assert.equal(t.acceptedBy, 'PO');
    assert.equal(dash.milestones.length, 2);
    assert.equal(dash.aims.page.mkt, 'Страница опубликована');
    assert.equal(dash.goal.metric.value, 42);

    const bad = await client.callTool({ name: 'add_task', arguments: { scope: 'nope', title: 'x' } });
    assert.equal(bad.isError, true);

    await client.callTool({ name: 'delete_task', arguments: { id: added.id } });
    assert.ok(!store.listTasks().some((x) => x.id === added.id));
  } finally {
    await client.close();
    server.close();
  }
});

test('с MCP_SECRET эндпоинт доступен только по секретному пути, сайт закрыт basic-auth', async () => {
  const { server, base } = await start({ mcpSecret: 's3cret', basicAuth: 'team:pass' });
  try {
    const open = await fetch(`${base}/mcp`, { method: 'POST' });
    assert.equal(open.status, 401); // /mcp без секрета попадает под basic-auth
    const client = await connect(`${base}/mcp/s3cret`);
    assert.ok((await client.listTools()).tools.length > 0);
    await client.close();
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    const ok = await fetch(`${base}/api/state`, { headers: { Authorization: 'Basic ' + Buffer.from('team:pass').toString('base64') } });
    assert.equal(ok.status, 200);
  } finally {
    server.close();
  }
});

test('REST API для сайта', async () => {
  const { server, base } = await start();
  try {
    const state = await (await fetch(`${base}/api/state`)).json();
    const id = state.tasks[0].id;
    const r = await fetch(`${base}/api/tasks/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done: true, acceptedBy: 'PO' }) });
    assert.equal((await r.json()).done, true);
    const noWho = await fetch(`${base}/api/tasks/${state.tasks[1].id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done: true }) });
    assert.equal(noWho.status, 200); // имя принявшего необязательно
    assert.equal((await noWho.json()).acceptedBy, null);
    const bad = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'art', title: '' }) });
    assert.equal(bad.status, 400);
  } finally {
    server.close();
  }
});

test('Claude ведёт спринты через MCP, метрики пересчитываются сами', async () => {
  const { server, base } = await start();
  const client = await connect(`${base}/mcp`);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(!r.isError, r.content[0].text);
    return parse(r);
  };
  try {
    await call('upsert_sprint', {
      id: 'S1', start: '2026-08-03', end: '2026-08-14', goal: 'Разбор жанров', goal_status: 'Да',
      cards: [
        { title: '[SPIKE] Конкуренты (2)', result: 'Done' },
        { title: '[DESIGN] Вижн (3)', result: 'Перенос' },
        { title: '[DESIGN] Петля (3/1)', kind: 'Добор', result: 'Done', add_day: 6 },
      ],
    });
    await call('upsert_sprint', { id: 'S2', start: '2026-08-17', end: '2026-08-28', goal: 'Системы', goal_status: 'В процессе', make_active: true, criteria: [{ block: 'Мир', text: 'Тайлы приняты' }] });
    const card = await call('add_sprint_card', { sprint: 'S2', title: '[DESIGN] Петля (3/1)', streak: 2, result: 'В работе' });
    assert.equal(card.sp, 1); // второй спринт подряд — второе число из скобок
    await call('update_sprint_card', { sprint: 'S2', card: card.id, result: 'Done' });
    await call('set_sprint_criterion', { sprint: 'S2', index: 0, status: 'Выполнено' });

    const full = await call('get_sprint_metrics', {});
    const s1 = full.sprints.find((s) => s.id === 'S1').metrics;
    assert.equal(s1.velocity, 5);           // 2 из плана + 3 добора в Done
    assert.equal(s1.sayDo, 0.4);            // 2 SP из 5 SP плана
    assert.equal(s1.scopeChange, 0.6);      // 3 SP добора к 5 SP плана
    assert.equal(s1.firstAddDay, 6);
    assert.equal(s1.carryOver, 0.375);      // 3 SP переноса из 8 SP объёма
    assert.equal(full.activeSprint, 'S2');
    assert.equal(full.team.goalSuccess.rate, 1);
    assert.equal(full.current.criteriaDone, 1);
    assert.ok(full.method.sayDo.how);

    const dash = await (await fetch(`${base}/api/state`)).json();
    assert.equal(dash.sprintsTeam.current.id, 'S2');
    assert.equal(JSON.stringify(dash).includes('cards'), false); // карточки не ходят в общем состоянии

    const bad = await client.callTool({ name: 'upsert_sprint', arguments: { id: 'S3', goal: 'без дат' } });
    assert.equal(bad.isError, true);
  } finally {
    await client.close();
    server.close();
  }
});

test('REST для спринтов: подробные метрики отдельно от общего состояния', async () => {
  const { server, base } = await start();
  const json = { 'Content-Type': 'application/json' };
  try {
    const put = await fetch(`${base}/api/sprints/S1`, { method: 'PUT', headers: json, body: JSON.stringify({ start: '2026-08-03', end: '2026-08-14', cards: [{ title: 'Карточка (2)', result: 'Done' }, { title: 'Ещё (3)', kind: 'Добор', result: 'Перенос', addDay: 4 }] }) });
    assert.equal(put.status, 200);
    const full = await (await fetch(`${base}/api/sprints/full`)).json();
    assert.equal(full.sprints[0].metrics.velocity, 2);
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.sprintsTeam.current.percent, 100); // Say/Do: 2 SP плана закрыты из 2, добор не считается
    assert.equal(JSON.stringify(state).includes('cards'), false);
    const page = await fetch(`${base}/sprint`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Метрики спринтов/);
    const bad = await fetch(`${base}/api/sprints/S1/cards`, { method: 'POST', headers: json, body: JSON.stringify({ title: 'x', result: 'Готово' }) });
    assert.equal(bad.status, 400);
  } finally {
    server.close();
  }
});
