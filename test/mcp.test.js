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
    assert.deepEqual(names, ['add_task', 'delete_task', 'get_dashboard', 'list_tasks', 'set_goal', 'set_task_done', 'update_task']);

    const added = parse(await client.callTool({ name: 'add_task', arguments: { scope: 'design', title: 'Нарратив', weight: 2 } }));
    assert.equal(added.scope, 'design');
    await client.callTool({ name: 'set_task_done', arguments: { id: added.id, done: true } });
    await client.callTool({ name: 'update_task', arguments: { id: added.id, title: 'Нарратив и диалоги' } });
    await client.callTool({ name: 'set_goal', arguments: { title: 'Вертикальный срез' } });

    const dash = parse(await client.callTool({ name: 'get_dashboard', arguments: {} }));
    assert.equal(dash.goal.title, 'Вертикальный срез');
    const t = dash.tasks.find((x) => x.id === added.id);
    assert.equal(t.title, 'Нарратив и диалоги');
    assert.equal(t.done, true);
    assert.ok(dash.summary.percent > 0);

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
    const r = await fetch(`${base}/api/tasks/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done: true }) });
    assert.equal((await r.json()).done, true);
    const bad = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'art', title: '' }) });
    assert.equal(bad.status, 400);
  } finally {
    server.close();
  }
});
