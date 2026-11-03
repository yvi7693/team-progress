import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store, ValidationError, NotFoundError, summarize } from '../src/store.js';

const fresh = async () => new Store(path.join(await mkdtemp(path.join(tmpdir(), 'tp-')), 'db.json')).load();

test('первый запуск создаёт файл с целью, скоупами и задачами', async () => {
  const store = await fresh();
  const saved = JSON.parse(await readFile(store.file, 'utf8'));
  assert.equal(saved.goal.title, 'Демо к Steam Next Fest');
  assert.equal(saved.scopes.length, 5);
  assert.ok(saved.tasks.length > 0);
});

test('прогресс считается по весам, доли скоупов складываются в общий процент', () => {
  const state = {
    goal: { title: 'x' },
    scopes: [{ id: 'a', name: 'A', color: '#000' }, { id: 'b', name: 'B', color: '#000' }],
    tasks: [
      { scope: 'a', weight: 3, done: true },
      { scope: 'a', weight: 1, done: false },
      { scope: 'b', weight: 1, done: true },
      { scope: 'b', weight: 3, done: false },
    ],
  };
  const s = summarize(state);
  assert.equal(s.percent, 50);
  assert.equal(s.scopes[0].percent, 75);
  assert.equal(s.scopes[1].percent, 25);
  assert.equal(Math.round(s.scopes[0].share + s.scopes[1].share), 50);
});

test('добавление, изменение, закрытие и удаление задачи', async () => {
  const store = await fresh();
  const t = await store.addTask({ scope: 'art', title: '  Новая задача  ', weight: 3 });
  assert.equal(t.title, 'Новая задача');
  const moved = await store.updateTask(t.id, { scope: 'code', weight: 1 });
  assert.equal(moved.scope, 'code');
  const done = await store.updateTask(t.id, { done: true });
  assert.equal(done.done, true);
  assert.ok(done.doneAt);
  await store.deleteTask(t.id);
  assert.ok(!store.listTasks().some((x) => x.id === t.id));
});

test('изменения сохраняются в файл и переживают перезапуск', async () => {
  const store = await fresh();
  await store.setGoal({ title: 'Релиз в Steam' });
  const again = await new Store(store.file).load();
  assert.equal(again.snapshot().goal.title, 'Релиз в Steam');
});

test('некорректные данные отклоняются понятной ошибкой', async () => {
  const store = await fresh();
  await assert.rejects(store.addTask({ scope: 'nope', title: 'x' }), ValidationError);
  await assert.rejects(store.addTask({ scope: 'art', title: '   ' }), ValidationError);
  await assert.rejects(store.addTask({ scope: 'art', title: 'x', weight: 5 }), ValidationError);
  await assert.rejects(store.updateTask('missing', { done: true }), NotFoundError);
  await assert.rejects(store.setGoal({ title: '' }), ValidationError);
});

test('каждое изменение рассылает событие change', async () => {
  const store = await fresh();
  let events = 0;
  store.on('change', () => events++);
  await store.setGoal({ title: 'A' });
  await store.addTask({ scope: 'mkt', title: 'B' });
  assert.equal(events, 2);
});
