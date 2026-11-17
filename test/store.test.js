import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { Store, ValidationError, NotFoundError, summarize, normalize, loadSeedFile } from '../src/store.js';

const fresh = async () => new Store(path.join(await mkdtemp(path.join(tmpdir(), 'tp-')), 'db.json')).load();

test('первый запуск создаёт файл с целью, скоупами и задачами', async () => {
  const store = await fresh();
  const saved = JSON.parse(await readFile(store.file, 'utf8'));
  assert.equal(saved.version, 2);
  assert.equal(saved.milestones.length, 1);
  assert.equal(saved.scopes.length, 5);
  assert.ok(saved.tasks.length > 0);
});

test('прогресс считается по весам, доли скоупов складываются в общий процент', () => {
  const state = normalize({
    goal: { title: 'x' },
    scopes: [{ id: 'a', name: 'A', color: '#000' }, { id: 'b', name: 'B', color: '#000' }],
    tasks: [
      { scope: 'a', weight: 3, done: true },
      { scope: 'a', weight: 1, done: false },
      { scope: 'b', weight: 1, done: true },
      { scope: 'b', weight: 3, done: false },
    ],
  });
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
  const done = await store.updateTask(t.id, { done: true, acceptedBy: 'PO' });
  assert.equal(done.done, true);
  assert.equal(done.acceptedBy, 'PO');
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

test('старый файл без рубежей мигрирует: все задачи попадают в один рубеж', () => {
  const s = normalize({ goal: { title: 'Старая цель' }, scopes: [{ id: 'a', name: 'A', color: '#000' }], tasks: [{ id: 't1', scope: 'a', title: 'x', weight: 2, done: true }] });
  assert.equal(s.version, 2);
  assert.equal(s.milestones.length, 1);
  assert.equal(s.tasks[0].milestone, s.milestones[0].id);
  assert.deepEqual(s.tasks[0].criteria, []);
  assert.equal(s.activeMilestone, s.milestones[0].id);
});

test('процент считается внутри рубежа, другие рубежи на него не влияют', async () => {
  const store = await fresh();
  await store.addMilestone({ id: 'next', title: 'Следующий' });
  const a = await store.addTask({ milestone: 'next', scope: 'art', title: 'A', weight: 1 });
  await store.addTask({ milestone: 'next', scope: 'art', title: 'B', weight: 1 });
  await store.updateTask(a.id, { done: true, acceptedBy: 'PO' });
  const sum = store.snapshot().summary;
  assert.equal(sum.milestones.find((m) => m.id === 'next').percent, 50);
  assert.equal(sum.percent, 0); // активный рубеж не изменился
});

test('задача не закрывается без всех критериев, без закрытых зависимостей и без принявшего', async () => {
  const store = await fresh();
  const base = await store.addTask({ scope: 'design', title: 'Документ', criteria: ['Описан'] });
  const t = await store.addTask({ scope: 'code', title: 'В билде', criteria: ['Работает', 'Проверено'], blockedBy: [base.id] });
  await assert.rejects(store.updateTask(t.id, { done: true, acceptedBy: 'PO' }), /Не отмечены критерии/);
  await store.checkCriterion(t.id, 0, true);
  await store.checkCriterion(t.id, 1, true);
  await assert.rejects(store.updateTask(t.id, { done: true, acceptedBy: 'PO' }), /Сначала должны быть закрыты/);
  await store.updateTask(base.id, { checks: [true], done: true, acceptedBy: 'PO' });
  await assert.rejects(store.updateTask(t.id, { done: true }), ValidationError);
  const closed = await store.updateTask(t.id, { done: true, acceptedBy: 'Дмитрий' });
  assert.equal(closed.acceptedBy, 'Дмитрий');
  await assert.rejects(store.updateTask(base.id, { done: false }), /зависят закрытые/);
  await assert.rejects(store.checkCriterion(t.id, 0, false), ValidationError);
  await store.updateTask(t.id, { done: false });
  assert.equal(store.snapshot().tasks.find((x) => x.id === t.id).acceptedBy, null);
});

test('зависимости без циклов, удаление задачи чистит ссылки', async () => {
  const store = await fresh();
  const a = await store.addTask({ scope: 'art', title: 'A' });
  const b = await store.addTask({ scope: 'art', title: 'B', blockedBy: [a.id] });
  await assert.rejects(store.updateTask(a.id, { blockedBy: [b.id] }), /цикл/);
  await assert.rejects(store.updateTask(a.id, { blockedBy: [a.id] }), ValidationError);
  await store.deleteTask(a.id);
  assert.deepEqual(store.snapshot().tasks.find((x) => x.id === b.id).blockedBy, []);
});

test('рубежи, фразы аспектов и показатель цели', async () => {
  const store = await fresh();
  await store.addMilestone({ id: 'page', title: 'Страница', criterion: 'опубликована', date: '28.11' });
  await store.setActiveMilestone('page');
  await store.setAim('page', 'mkt', 'Страница опубликована');
  await store.setMetric({ value: 120, ladder: [{ value: 500, label: 'через 2 недели' }] });
  const s = store.snapshot();
  assert.equal(s.activeMilestone, 'page');
  assert.equal(s.aims.page.mkt, 'Страница опубликована');
  assert.equal(s.goal.metric.value, 120);
  await assert.rejects(store.deleteMilestone('demo'), /есть задачи/);
  await assert.rejects(store.addMilestone({ id: 'плохой id', title: 'x' }), ValidationError);
});

test('файл плана загружается и проверяется на противоречия', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tp-'));
  const plan = {
    goal: { title: 'Цель' },
    scopes: [{ id: 'a', name: 'A', color: '#000' }],
    milestones: [{ id: 'm', title: 'Рубеж' }],
    tasks: [
      { id: 'x', milestone: 'm', scope: 'a', title: 'X', weight: 1, criteria: [{ text: 'c', done: true }], done: true, acceptedBy: 'PO' },
      { id: 'y', milestone: 'm', scope: 'a', title: 'Y', weight: 1, blockedBy: ['x'] },
    ],
  };
  const ok = path.join(dir, 'ok.json');
  await writeFile(ok, JSON.stringify(plan));
  const store = await new Store(path.join(dir, 'db.json'), { seedFile: ok }).load();
  assert.equal(store.snapshot().summary.percent, 50);

  plan.tasks[0].done = false;
  plan.tasks[0].acceptedBy = null;
  plan.tasks[1] = { ...plan.tasks[1], done: true, acceptedBy: 'PO' };
  const bad = path.join(dir, 'bad.json');
  await writeFile(bad, JSON.stringify(plan));
  await assert.rejects(loadSeedFile(bad), /закрыта раньше/);
});
