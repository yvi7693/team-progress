// Страница метрик спринтов (/sprint): цель текущего спринта и основные метрики
// (state.sprintsTeam). Кнопка «Для scrum-мастера» раскрывает подробные метрики:
// их страница запрашивает отдельно (/api/sprints/full), в общем состоянии их нет.
// Виджет на главном экране — в sprint-widget.js.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const num = (x) => (typeof x === 'number' ? n1.format(x) : x ?? '—');
const pct = (x) => (typeof x === 'number' ? `${Math.round(x * 100)}%` : x ?? '—');
const PCT_KEYS = new Set(['sayDo', 'scopeChange', 'carryOver', 'rate']);
const fmt = (key, x) => (PCT_KEYS.has(key) ? pct(x) : num(x));

const lsGet = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const lsSet = (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch {} };

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const day = (iso) => { const [, m, d] = iso.split('-').map(Number); return { d, m: m - 1 }; };
function range(start, end) {
  if (!start || !end) return '';
  const a = day(start), b = day(end);
  return a.m === b.m ? `${a.d}–${b.d} ${MONTHS[b.m]}` : `${a.d} ${MONTHS[a.m]} – ${b.d} ${MONTHS[b.m]}`;
}
const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};

const GOAL_CLS = { 'Да': 'ok', 'Частично': 'part', 'Нет': 'no', 'В процессе': 'now' };
const CRIT_CLS = { 'Выполнено': 'ok', 'В работе': 'now', 'Проверить в сборке': 'part', 'Нет карточки в спринте': 'no' };
const pill = (text, cls) => `<span class="pill ${cls || ''}">${esc(text || 'не оценена')}</span>`;

let team = null;
let full = null;
let smOpen = lsGet('smOpen') === '1'; // раскрыт ли блок scrum-мастера (запоминается в браузере)
let cardsOf = null;       // спринт, карточки которого раскрыты у scrum-мастера
let refreshTimer = null;

// ── Командный вид ──────────────────────────────────────────────────────────
// График метрики по спринтам: столбик на спринт, пунктир — среднее по прошлым спринтам,
// текущий спринт выделен (пока идёт — штриховкой, числа предварительные).
// При наведении или фокусе столбика всплывает подсказка с числом, итогом цели и разницей со средним.
const UNIT = { velocity: ' SP', throughput: ' карт.', sayDo: '', scopeChange: '', carryOver: '', firstAddDay: '-й день', longCards: ' карт.' };
const DUNIT = { ...UNIT, firstAddDay: ' дн.' };
// Что считается улучшением — подсказка на плашке разницы со средним.
const BETTER = { velocity: 'рост (но смотри размер карточек)', throughput: 'рост', sayDo: 'ближе к 100%', scopeChange: 'снижение', firstAddDay: 'позже — больше число', carryOver: 'снижение', longCards: 'меньше' };
const deltaText = (key, d) => {
  if (typeof d !== 'number') return '';
  const sign = d > 0 ? '+' : d < 0 ? '−' : '±';
  const abs = Math.abs(d);
  return PCT_KEYS.has(key) ? `${sign}${Math.round(abs * 100)} п.п.` : `${sign}${num(abs)}${DUNIT[key]}`;
};
// Почему у спринта нет числа: «нет» — добора не было, «спринт идёт» — считается после конца.
const noValue = (raw) => (raw === 'нет' ? 'добора не было' : typeof raw === 'string' ? raw : 'нет данных');
function chart(history, key, c, average) {
  const vals = history.map((h) => (typeof h[key] === 'number' ? h[key] : null));
  const top = Math.max(...vals.filter((v) => v !== null), average ?? 0, key === 'sayDo' ? 1 : 0) * 1.12 || 1;
  const h = (v) => (v === null ? 0 : Math.max(3, (v / top) * 100));
  const cols = history.map((x, i) => {
    const v = vals[i];
    const cur = x.id === c.id;
    const tip = [
      `<b>${esc(x.id)}${cur && c.running ? ' · идёт' : ''}</b>`,
      `<span>${v === null ? esc(noValue(x[key])) : fmt(key, v) + UNIT[key]}</span>`,
      typeof v === 'number' && typeof average === 'number' && !cur ? `<span>${deltaText(key, v - average)} к среднему</span>` : '',
      x.goalStatus ? `<span>цель: ${esc(x.goalStatus.toLowerCase())}</span>` : '',
    ].filter(Boolean).join('');
    return `<button type="button" class="col${cur ? ' cur' : ''}${cur && c.running ? ' run' : ''}" style="--h:${h(v)}%" data-tip="${esc(tip)}" aria-label="${esc(x.id)}: ${v === null ? esc(noValue(x[key])) : esc(fmt(key, v) + UNIT[key])}"><i></i></button>`;
  }).join('');
  const avgLine = typeof average === 'number' ? `<span class="avg" style="bottom:${h(average)}%" aria-hidden="true"></span>` : '';
  return `<div class="chart">
    <div class="plot">${avgLine}${cols}</div>
    <div class="xl" aria-hidden="true">${history.map((x) => `<span class="${x.id === c.id ? 'cur' : ''}">${esc(x.id)}</span>`).join('')}</div>
    <div class="tip" role="status" hidden></div>
  </div>`;
}

// Подсказки графиков: одна на график, двигается к столбику под курсором или фокусом.
function showTip(col) {
  const chartEl = col.closest('.chart');
  const tip = chartEl.querySelector('.tip');
  chartEl.querySelectorAll('.col.on').forEach((x) => x.classList.remove('on'));
  col.classList.add('on');
  tip.innerHTML = col.dataset.tip;
  tip.hidden = false;
  const box = chartEl.getBoundingClientRect(), r = col.getBoundingClientRect();
  const x = r.left - box.left + r.width / 2;
  const left = Math.min(Math.max(x, tip.offsetWidth / 2), box.width - tip.offsetWidth / 2);
  tip.style.left = `${left}px`;
  tip.style.setProperty('--ax', `${x - left + tip.offsetWidth / 2}px`); // хвостик смотрит на столбик
  const barTop = col.querySelector('i').getBoundingClientRect().top - box.top;
  tip.style.top = `${barTop - tip.offsetHeight - 10}px`;
}
function hideTip(chartEl) {
  chartEl.querySelector('.tip').hidden = true;
  chartEl.querySelectorAll('.col.on').forEach((x) => x.classList.remove('on'));
}
for (const box of [$('spTeam'), $('smZone')]) {
  box.addEventListener('pointerover', (e) => { const col = e.target.closest('.col'); if (col) showTip(col); });
  box.addEventListener('pointerout', (e) => { const chartEl = e.target.closest('.chart'); if (chartEl && !chartEl.contains(e.relatedTarget)) hideTip(chartEl); });
  box.addEventListener('focusin', (e) => { const col = e.target.closest('.col'); if (col) showTip(col); });
  box.addEventListener('focusout', (e) => { const chartEl = e.target.closest('.chart'); if (chartEl) hideTip(chartEl); });
}

// Плитка метрики: название, значение текущего спринта, разница со средним и график по спринтам.
// Одна и та же у команды и у scrum-мастера. note — строка вместо сравнения, когда числа нет.
function metricTile({ key, name, current, average, improved, extra, note }, history, c, past) {
  const has = typeof current === 'number';
  const d = has && typeof average === 'number' ? current - average : null;
  // Стрелка — куда сдвинулось число, цвет — стало лучше (зелёный) или хуже (красный).
  const cls = improved === true ? 'up' : improved === false ? 'down' : 'flat';
  const big = !has ? `<p class="big txt">${esc(current === 'нет' ? 'без добора' : current ?? '—')}</p>`
    : `<p class="big">${fmt(key, current)}${key === 'velocity' ? '<small> SP</small>' : key === 'firstAddDay' ? '<small>-й день</small>' : ''}</p>`;
  const avg = typeof average === 'number' ? `<span class="avgtxt"><i aria-hidden="true"></i>среднее ${esc(past)} — <b>${fmt(key, average)}</b></span>` : '';
  const cmp = d !== null ? `<p class="cmp"><span class="delta ${cls}" title="${cls === 'up' ? 'Лучше' : cls === 'down' ? 'Хуже' : 'Так же, как'} среднего. Улучшение: ${esc(BETTER[key] || '')}">${d > 0 ? '↑' : d < 0 ? '↓' : ''} ${deltaText(key, d)}</span>${avg}</p>`
    : `<p class="cmp">${note ? `<span>${esc(note)}</span>` : ''}${avg}</p>`;
  return `
      <article class="tile mt">
        <h3>${esc(name)}</h3>
        ${big}
        ${cmp}
        ${extra ? `<p class="sub extra">${esc(extra)}</p>` : ''}
        ${chart(history, key, c, average)}
      </article>`;
}


// Кольцо прогресса спринта (Say/Do: SP, закрытые из плана ÷ SP плана) и цепочка
// спринтов: у прошлых — итог цели, текущий отмечен как идущий.
const ICON = {
  ok: '<path d="M5 10.5l3.2 3 6-7"/>',
  part: '<path d="M5.5 10h9"/>',
  no: '<path d="M6 6l8 8M14 6l-8 8"/>',
  now: '<path d="M8 6l6 4-6 4z" class="fillp"/>',
  none: '<circle cx="10" cy="10" r="1.6" class="fillp"/>',
};
// Сколько рабочих дней осталось: «1 день», «6 дней». Если план не закрыт, а до конца
// 2 рабочих дня или меньше, сроки горят — число и подпись подсвечиваются красным.
function daysBadge(c) {
  const left = c.workdaysLeft;
  const done = c.percent >= 100;
  if (!left) return `<p class="days end">${c.running ? 'Спринт закончился по датам' : 'Спринт завершён'}</p>`;
  const level = done ? 'ok' : left <= 2 ? 'hot' : '';
  return `<p class="days ${level}" title="Рабочих дней до конца спринта${level === 'hot' ? ', план ещё не закрыт' : ''}"><b>${left}</b> ${plural(left, 'день', 'дня', 'дней')}</p>`;
}

let barFrom = null; // прошлое значение полосы: при обновлении она доливается от него
// Прогресс спринта — горизонтальная полоса Say/Do: процент слева, рабочие дни справа,
// под полосой цепочка спринтов. Когда план закрыт, полоса зеленеет и по ней пробегает блик.
function goalRow(t, c) {
  const share = Math.min(c.percent, 100);
  const full = c.percent >= 100;
  const from = barFrom ?? 0;
  barFrom = share;
  const bar = `
    <div class="gbhead">
      <p class="gpct">${full ? '<i class="chk" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M5 10.5l3.2 3 6-7"/></svg></i>' : ''}<b>${c.percent}<small>%</small></b><span>Say/Do</span></p>
      ${daysBadge(c)}
    </div>
    <div class="gbar${full ? ' full' : ''}" role="progressbar" aria-label="Прогресс спринта ${esc(c.id)} по Say/Do" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${c.percent}">
      <i data-to="${share}" style="width:${from}%"></i>
    </div>`;
  const chain = t.history.map((h) => {
    const cls = h.id === c.id && (c.running || !h.goalStatus || h.goalStatus === 'В процессе') ? 'now' : GOAL_CLS[h.goalStatus] || 'none';
    const word = cls === 'now' ? 'идёт' : h.goalStatus ? h.goalStatus.toLowerCase() : 'не оценена';
    return `<li class="${cls}${h.id === c.id ? ' cur' : ''}" title="${esc(h.id)}: ${esc(word)}${h.goal ? ` — ${esc(h.goal)}` : ''}">
      <span class="dotc"><svg viewBox="0 0 20 20" aria-hidden="true">${ICON[cls]}</svg></span><span class="sid">${esc(h.id)}</span><span class="sr-only">: цель ${esc(word)}</span></li>`;
  }).join('');
  return `<div class="goalrow">${bar}
    <div class="gchain">
      <ol aria-label="Итог цели по спринтам">${chain}</ol>
    </div>
  </div>`;
}

// Цель спринта пишут как «что сделать. Зачем: для чего». Часть «Зачем» показываем отдельно.
function splitGoal(text) {
  const m = /^([\s\S]*?)(?:^|[\s.;]+)Зачем\s*[:—-]\s*([\s\S]+)$/i.exec(text || '');
  if (!m) return { what: text || '', why: '' };
  const why = m[2].trim();
  return { what: m[1].trim().replace(/[.;,]?$/, '.'), why: why.charAt(0).toUpperCase() + why.slice(1) };
}

// «S8» → «Sprint 8»; id другого вида показывается как есть.
const sprintName = (id) => { const m = /^s(\d+)$/i.exec(id); return m ? `Sprint ${m[1]}` : id; };

function renderTeam() {
  const t = team;
  if (!t || !t.current) {
    $('spTeam').innerHTML = `<div class="spempty"><h2>Спринтов пока нет</h2><p>Попросите Claude перенести спринты из таблицы метрик или создать текущий спринт: инструмент <code>upsert_sprint</code>.</p></div>`;
    return;
  }
  const c = t.current;
  const blocks = [...new Set(c.criteria.map((x) => x.block || ''))];
  const goal = splitGoal(c.goal);
  const before = t.history.slice(0, t.history.findIndex((h) => h.id === c.id));
  const past = before.length ? (before.length > 1 ? `${before[0].id}–${before.at(-1).id}` : before[0].id) : '';

  $('spTeam').innerHTML = `
    <section class="spgoal" aria-labelledby="spGoalT">
      <h1 class="sptitle">${esc(sprintName(c.id))}</h1>
      <p class="kicker">Цель спринта · ${esc(range(c.start, c.end))}</p>
      <h2 class="mst" id="spGoalT">${esc(goal.what || 'Цель спринта ещё не записана')}</h2>
      ${c.goalStatus && c.goalStatus !== 'В процессе' ? `<p class="gstat">Итог: ${pill(c.goalStatus, GOAL_CLS[c.goalStatus])}</p>` : ''}
      ${goalRow(t, c)}
      ${goal.why ? `<div class="why"><h3>Зачем</h3><p>${esc(goal.why)}</p></div>` : ''}
      ${c.criteriaTotal ? `
        <h3 class="crith">Критерии приёмки <span>${c.criteriaDone} из ${c.criteriaTotal} выполнено</span></h3>
        <div class="crits">${blocks.map((b) => `
          <div class="cb"><h3>${esc(b || 'Критерии')}</h3><ul>${c.criteria.filter((x) => (x.block || '') === b).map((x) => `
            <li class="${CRIT_CLS[x.status] || ''}"><span class="mk" aria-hidden="true"></span><span class="ct">${esc(x.text)}</span>${pill(x.status, CRIT_CLS[x.status])}</li>`).join('')}</ul></div>`).join('')}
        </div>` : '<p class="muted">Критериев приёмки у цели нет. Без них итог цели оценивают по отчёту спринта.</p>'}
    </section>

    <section class="tiles three" aria-label="Основные метрики">
      ${t.main.map((m) => metricTile(m, t.history, c, past)).join('')}
    </section>`;
  // Полоса доливается от прошлого значения до нового (при первом показе — от нуля).
  const fill = $('spTeam').querySelector('.gbar i');
  if (fill) requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = `${fill.dataset.to}%`; }));
}

// ── Scrum-мастер ───────────────────────────────────────────────────────────
async function fetchFull() {
  const res = await fetch('/api/sprints/full');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
  full = data;
}

// Свёрнутый блок: одна кнопка для scrum-мастера.
function smToggle() {
  return `<button class="smbtn" type="button" id="smToggle" aria-expanded="${smOpen}">
    <span><b>Для scrum-мастера</b><small>Scope Change, добор, Carry-over, все спринты, цели и карточки</small></span><i aria-hidden="true">▾</i></button>`;
}


const COLS = [
  ['velocity', 'Velocity'], ['throughput', 'Done, карт'], ['sayDo', 'Say/Do'], ['scopeChange', 'Scope Change'],
  ['firstAddDay', 'Первый добор'], ['carryOver', 'Carry-over'], ['planCards', 'План, карт'], ['planSP', 'План, SP'],
  ['addCards', 'Добор, карт'], ['addSP', 'Добор, SP'], ['doneFromPlanSP', 'Done из плана, SP'], ['carryCards', 'Перенос, карт'],
  ['carrySP', 'Перенос, SP'], ['inWorkCards', 'В работе'], ['clarifySP', 'Уточнение, SP'], ['unestimatedCards', 'Без оценки'],
];

// Сводка по карточкам выбранного спринта: откуда пришла работа (план, добор)
// и чем она кончилась (Done, перенос, в работе, снято) — числами и полосой по SP.
function cardsSummary(sprint) {
  const cards = sprint.cards;
  const sum = (list) => list.reduce((a, c) => a + (c.sp || 0), 0);
  const by = (f) => { const list = cards.filter(f); return { n: list.length, sp: sum(list) }; };
  const src = [
    ['План', by((c) => c.kind === 'План')],
    ['Добор', by((c) => c.kind === 'Добор')],
    ...(cards.some((c) => c.kind === 'Уточнение') ? [['Уточнение', by((c) => c.kind === 'Уточнение')]] : []),
  ];
  const out = [
    ['ok', 'Done', by((c) => c.result === 'Done')],
    ['now', 'В работе', by((c) => c.result === 'В работе')],
    ['part', 'Перенос', by((c) => c.result === 'Перенос')],
    ['off', 'Снято', by((c) => c.result === 'Снята' || c.result === 'Закрыта без Done')],
  ];
  const total = sum(cards) || 1;
  const cell = (label, v, cls = '') => `<div class="cs ${cls}"><span>${cls ? '<i></i>' : ''}${esc(label)}</span><b>${v.n}<small> ${plural(v.n, 'карточка', 'карточки', 'карточек')}</small></b><em>${num(v.sp)} SP</em></div>`;
  return `<div class="csum">
    <div class="csrow">
      <div class="csgrp"><p>Взято в спринт</p><div>${src.map(([l, v]) => cell(l, v)).join('')}</div></div>
      <div class="csgrp"><p>Чем закончилось</p><div>${out.map(([c, l, v]) => cell(l, v, c)).join('')}</div></div>
    </div>
    <div class="csbar" role="img" aria-label="${out.map(([, l, v]) => `${l}: ${num(v.sp)} SP`).join(', ')}">${out.filter(([, , v]) => v.sp > 0).map(([c, l, v]) => `<span class="${c}" style="flex:${v.sp}" title="${esc(l)}: ${num(v.sp)} SP (${Math.round((v.sp / total) * 100)}%)"></span>`).join('')}</div>
  </div>`;
}

function renderFull() {
  const f = full;
  const cur = f.current;
  if (!cur) {
    $('smZone').innerHTML = `${smToggle()}<p class="muted">Спринтов пока нет.</p>`;
    return;
  }
  const m = cur.metrics;
  const over = f.averagesOver.length ? `${f.averagesOver[0]}–${f.averagesOver.at(-1)}` : '—';
  if (!cardsOf || !f.sprints.some((s) => s.id === cardsOf)) cardsOf = cur.id;
  const sel = f.sprints.find((s) => s.id === cardsOf);
  // Углублённые метрики — такие же плитки с графиками, как у команды.
  const d = Object.fromEntries(f.deltas.map((x) => [x.key, x]));
  const hist = f.sprints.map((s) => ({ id: s.id, goalStatus: s.goalStatus, ...s.metrics }));
  const pastLong = f.sprints.filter((s) => f.averagesOver.includes(s.id)).map((s) => s.metrics.longCards);
  const longAvg = pastLong.length ? pastLong.reduce((a, b) => a + b, 0) / pastLong.length : null;
  const tiles = [
    { key: 'scopeChange', name: 'Scope Change', current: m.scopeChange, average: d.scopeChange?.average, improved: d.scopeChange?.improved, extra: `добор ${num(m.addSP)} SP к плану ${num(m.planSP)} SP` },
    { key: 'firstAddDay', name: 'Первый добор', current: m.firstAddDay, average: d.firstAddDay?.average, improved: d.firstAddDay?.improved, extra: typeof m.firstAddDay === 'number' ? (m.firstAddDay <= 5 ? 'первая неделя спринта' : 'вторая неделя спринта') : '' },
    { key: 'carryOver', name: 'Carry-over', current: m.carryOver, average: d.carryOver?.average, improved: d.carryOver?.improved, note: m.running ? 'считается после конца спринта' : '', extra: m.running ? `${m.inWorkCards} ${plural(m.inWorkCards, 'карточка', 'карточки', 'карточек')} ещё в работе` : `перенесено ${num(m.carrySP)} SP` },
    { key: 'longCards', name: 'Тянутся 2+ спринта', current: m.longCards, average: longAvg, improved: longAvg === null || m.longCards === longAvg ? null : m.longCards < longAvg, extra: `без оценки: ${m.unestimatedCards}, снято: ${m.droppedCards}` },
  ];

  $('smZone').innerHTML = `
    ${smToggle()}

    <section class="tiles quad" aria-label="Метрики планирования">
      ${tiles.map((x) => metricTile(x, hist, cur, over)).join('')}
    </section>

    <section class="smsec">
      <h3>Все спринты</h3>
      <div class="tscroll"><table class="dt nums">
        <thead><tr><th>Спринт</th><th>Цель</th>${COLS.map(([, h]) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
        <tbody>${f.sprints.map((s) => `<tr class="${s.id === cur.id ? 'cur' : ''}"><th scope="row">${esc(s.id)}</th><td>${pill(s.goalStatus, GOAL_CLS[s.goalStatus])}</td>${COLS.map(([k]) => `<td>${fmt(k, s.metrics[k])}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>
    </section>

    <section class="smsec">
      <h3>Цели спринтов</h3>
      <ol class="ghist">${[...f.sprints].reverse().map((s) => `<li>
        <div class="gh"><b>${esc(s.id)}</b><span class="muted">${esc(range(s.start, s.end))}</span>${pill(s.goalStatus, GOAL_CLS[s.goalStatus])}</div>
        <p>${esc(s.goal || '—')}</p>${s.goalBasis ? `<p class="muted">${esc(s.goalBasis)}</p>` : ''}</li>`).join('')}</ol>
    </section>

    <section class="smsec">
      <div class="cardshead">
        <h3>Карточки спринта</h3>
        <select id="smCards" aria-label="Спринт">${f.sprints.map((s) => `<option value="${esc(s.id)}" ${s.id === cardsOf ? 'selected' : ''}>${esc(s.id)} · ${s.cards.length} ${plural(s.cards.length, 'карточка', 'карточки', 'карточек')}</option>`).join('')}</select>
      </div>
      ${cardsSummary(sel)}
      <div class="tscroll"><table class="dt cards">
        <thead><tr><th>Карточка</th><th>Вид</th><th>SP</th><th>Результат</th><th>День добора</th><th>Подряд</th></tr></thead>
        <tbody>${sel.cards.map((c) => `<tr class="${c.streak >= 2 && c.result !== 'Done' ? 'long' : ''}">
          <td>${esc(c.title)}${c.note ? `<small>${esc(c.note)}</small>` : ''}</td><td>${esc(c.kind)}</td><td>${c.sp ?? '<span class="muted">—</span>'}</td>
          <td><span class="res r-${esc(c.result).replace(/\s+/g, '-')}">${esc(c.result)}</span></td><td>${c.addDay ?? ''}</td><td>${c.streak > 1 ? `${c.streak}-й` : ''}</td></tr>`).join('')}</tbody>
      </table></div>
    </section>`;
}

function renderSm() {
  if (smOpen && full) renderFull(); else $('smZone').innerHTML = smToggle();
}

async function refreshFull() {
  try { await fetchFull(); } catch { full = null; }
  renderSm();
}

// Новое общее состояние (с сайта или от Claude). Подробные метрики в SSE не приходят,
// поэтому при раскрытом блоке scrum-мастера перезапрашиваем их.
function onState(state) {
  team = state.sprintsTeam || null;
  document.title = team?.current ? `Спринт ${team.current.id}: ${team.current.percent}% — метрики спринтов` : 'Метрики спринтов';
  renderTeam();
  if (smOpen) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshFull, full ? 250 : 0);
  } else renderSm();
}

$('smZone').addEventListener('click', async (e) => {
  if (!e.target.closest('#smToggle')) return;
  smOpen = !smOpen;
  lsSet('smOpen', smOpen ? '1' : '');
  if (smOpen && !full) {
    $('smZone').innerHTML = `${smToggle()}<p class="loading">Загружаем метрики…</p>`;
    await refreshFull();
  }
  renderSm();
});
$('smZone').addEventListener('change', (e) => {
  if (e.target.id === 'smCards') { cardsOf = e.target.value; renderFull(); }
});

// Живые обновления, как на главной: изменения от команды и от Claude приходят сразу.
function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('state', (ev) => { $('offline').hidden = true; onState(JSON.parse(ev.data)); });
  es.onerror = () => { $('offline').hidden = false; };
}
fetch('/api/state').then((r) => r.json()).then(onState).catch(() => { $('offline').hidden = false; }).finally(connect);
