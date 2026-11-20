// Эффекты закрытия задач, скоупов и цели: налив, счётчики, конфетти, финальный экран, звук.
// При системной настройке «Уменьшить движение» движущиеся эффекты отключаются.
export const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Короткая пружинка на цифре, когда значение выросло.
export function bounce(el, delay = 0) {
  if (calm) return;
  setTimeout(() => {
    el.classList.remove('fx-bounce');
    void el.offsetWidth;
    el.classList.add('fx-bounce');
  }, delay);
}

// Счётчик процентов: быстро пробегает от старого значения к новому.
export function countUp(el, from, to, { delay = 0, duration = 800, format = (n) => n } = {}) {
  if (from === to || calm) return;
  el.innerHTML = format(from);
  const start = performance.now() + delay;
  const step = (t) => {
    if (!el.isConnected) return;
    const k = Math.min(1, Math.max(0, (t - start) / duration));
    const eased = 1 - Math.pow(1 - k, 3);
    el.innerHTML = format(Math.round(from + (to - from) * eased));
    if (k < 1) requestAnimationFrame(step);
    else if (to > from) bounce(el);
  };
  requestAnimationFrame(step);
}

let layer = null;
function fxLayer() {
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'fx-layer';
    document.body.append(layer);
  }
  return layer;
}

// Подпись «+7%» над концом заполненной части бара.
export function floatPlus(barEl, percent, text, color, delay = 0) {
  if (calm) return;
  const r = barEl.getBoundingClientRect();
  const x = Math.min(r.right - 12, Math.max(r.left + 12, r.left + (r.width * percent) / 100));
  const el = document.createElement('span');
  el.className = 'fx-float';
  el.textContent = text;
  el.style.cssText = `left:${x}px;top:${r.top - 4}px;--c:${color};animation-delay:${delay}ms`;
  fxLayer().append(el);
  setTimeout(() => el.remove(), 1400 + delay);
}

// Импульс: светлая волна бежит от конца налива до конца трека.
export function wave(barEl, percent, color, delay = 0) {
  if (calm || !barEl || percent >= 100) return;
  setTimeout(() => {
    if (!barEl.isConnected) return;
    const el = document.createElement('span');
    el.className = 'fx-wave';
    el.style.setProperty('--c', color);
    barEl.append(el);
    el.animate([{ left: `${percent}%`, opacity: 1 }, { left: '100%', opacity: 0 }], { duration: 700, easing: 'cubic-bezier(.3, 0, .3, 1)' })
      .finished.then(() => el.remove(), () => el.remove());
  }, delay);
}

// Серия: закрытия подряд с паузой меньше 30 секунд.
let streakN = 0, streakAt = 0, streakEl = null, streakTimer = 0;
export function streakHit(anchorEl, n = 1) {
  const now = Date.now();
  streakN = now - streakAt < 30000 ? streakN + n : n;
  streakAt = now;
  if (streakN < 2 || !anchorEl) return streakN;
  const r = anchorEl.getBoundingClientRect();
  if (!streakEl) {
    streakEl = document.createElement('span');
    streakEl.className = 'fx-streak';
    document.body.append(streakEl);
  }
  streakEl.textContent = `×${streakN} серия`;
  streakEl.style.cssText = `left:${r.right + scrollX + 8}px;top:${r.top + scrollY + 6}px`;
  streakEl.classList.remove('show');
  void streakEl.offsetWidth;
  streakEl.classList.add('show');
  clearTimeout(streakTimer);
  streakTimer = setTimeout(() => streakEl.classList.remove('show'), 5000);
  return streakN;
}

// Веха: подпись над главным процентом и вспышка отметки на общем баре.
const MILESTONE = { 25: 'Четверть пути', 50: 'Половина пути', 75: 'Три четверти пути' };
export function milestone(heroEl, barEl, m) {
  const r = heroEl.getBoundingClientRect();
  const el = document.createElement('span');
  el.className = 'fx-milestone';
  el.innerHTML = `<b>${m}%</b> ${MILESTONE[m]}`;
  el.style.cssText = `left:${r.left + scrollX + r.width / 2}px;top:${r.top + scrollY - 6}px`;
  document.body.append(el);
  setTimeout(() => el.remove(), 3200);
  const tick = document.createElement('span');
  tick.className = 'fx-tick';
  tick.style.left = `${m}%`;
  barEl.append(tick);
  setTimeout(() => tick.remove(), 2000);
  play('milestone');
}

// Конфетти: один канвас на всю страницу, частицы живут 2–3 секунды.
let cv = null, ctx = null, parts = [], raf = 0, last = 0;
function sizeCanvas() {
  const d = window.devicePixelRatio || 1;
  cv.width = innerWidth * d;
  cv.height = innerHeight * d;
  ctx.setTransform(d, 0, 0, d, 0, 0);
}
function tick(t) {
  const dt = Math.min(3, (t - last) / 16.67 || 1);
  last = t;
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  parts = parts.filter((p) => p.life < p.ttl && p.y < innerHeight + 40);
  for (const p of parts) {
    p.vx *= Math.pow(0.985, dt);
    p.vy = p.vy * Math.pow(0.985, dt) + 0.3 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rot += p.vr * dt;
    p.life += dt * 16.67;
    ctx.save();
    ctx.globalAlpha = Math.min(1, (p.ttl - p.life) / 500);
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.scale(1, Math.cos(p.rot * 1.7));
    ctx.fillStyle = p.color;
    if (p.round) { ctx.beginPath(); ctx.arc(0, 0, p.s / 2, 0, Math.PI * 2); ctx.fill(); }
    else ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
    ctx.restore();
  }
  raf = parts.length ? requestAnimationFrame(tick) : 0;
}
export function burst({ x, y, w = 0, colors, count = 80, angle = -90, spread = 35, power = 1 }) {
  if (calm) return;
  if (!cv) {
    cv = document.createElement('canvas');
    cv.className = 'fx-canvas';
    document.body.append(cv);
    ctx = cv.getContext('2d');
    sizeCanvas();
    addEventListener('resize', sizeCanvas);
  }
  for (let i = 0; i < count; i++) {
    const a = ((angle + (Math.random() * 2 - 1) * spread) * Math.PI) / 180;
    const v = (5 + Math.random() * 8) * power;
    parts.push({
      x: x + Math.random() * w, y,
      vx: Math.cos(a) * v, vy: Math.sin(a) * v,
      rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3,
      s: 6 + Math.random() * 5, round: Math.random() < 0.25,
      color: colors[i % colors.length],
      life: 0, ttl: 1800 + Math.random() * 1000,
    });
  }
  if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick); }
}

// Конфетти скоупа: выброс из его бара оттенками его цвета.
export function scopeConfetti(barEl, colors) {
  const r = barEl.getBoundingClientRect();
  burst({ x: r.left, y: r.top + r.height / 2, w: r.width, colors, count: 90, spread: 40 });
}

// Оттенки одного цвета, чтобы конфетти скоупа не было плоским.
export function shades(hex) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (k) => '#' + [16, 8, 0].map((s) => Math.round(((n >> s) & 255) + (255 - ((n >> s) & 255)) * k).toString(16).padStart(2, '0')).join('');
  return [hex, hex, mix(0.3), mix(0.55)];
}

const CHECK = '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="10"/><path d="M5.8 10.4l2.8 2.7 5.6-6"/></svg>';
export const closedBadge = `<span class="ok"><span class="okic">${CHECK}</span>Закрыт</span>`;

// Финальный экран: бар собирается по скоупам, затем 100%, конфетти всех цветов и итог.
export function showFinale({ kicker = 'Цель достигнута', title, tasksDone, scopesDone, scopesTotal, scopesLabel = 'скоупов', segments }) {
  document.querySelector('.finale')?.remove();
  const el = document.createElement('div');
  el.className = 'finale';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', kicker);
  const pre = calm ? 0 : 250 + segments.length * 260; // время сборки бара перед 100%
  el.innerHTML = `<div class="card">
    <p class="kicker">${kicker}</p>
    <h2>${title}</h2>
    <div class="big" style="animation-delay:${pre + 100}ms">100<small>%</small></div>
    <div class="bar main">${segments.map((s) => `<i style="width:${calm ? s.share : 0}%;background:${s.color}" data-w="${s.share}"></i>`).join('')}</div>
    <div class="stats">
      <div class="stat"><b>${tasksDone}</b><span>закрыто задач</span></div>
      <div class="stat"><b>${scopesDone} из ${scopesTotal}</b><span>пройдено ${scopesLabel}</span></div>
    </div>
    <button type="button" class="btn primary">Продолжить</button>
  </div>`;
  document.body.append(el);
  const close = () => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 250);
    removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  addEventListener('keydown', onKey);
  el.querySelector('button').addEventListener('click', close);
  el.querySelector('button').focus({ preventScroll: true });

  if (!calm) {
    el.querySelectorAll('.bar i').forEach((i, n) => setTimeout(() => {
      i.style.width = `${i.dataset.w}%`;
      i.classList.add('justsealed', 'now');
      play('note', n);
    }, 250 + n * 260));
  }
  countUp(el.querySelector('.big'), 80, 100, { delay: pre + 150, duration: 700, format: (n) => `${n}<small>%</small>` });
  setTimeout(() => {
    play('goal');
    vibrate('goal');
    const colors = segments.map((s) => s.color);
    [0, 1, 2].forEach((i) => setTimeout(() => {
      burst({ x: 0, y: innerHeight, colors, count: 70, angle: -60, spread: 20, power: 1.6 });
      burst({ x: innerWidth, y: innerHeight, colors, count: 70, angle: -120, spread: 20, power: 1.6 });
      if (i === 1) burst({ x: innerWidth * 0.2, y: -10, w: innerWidth * 0.6, colors, count: 120, angle: 90, spread: 30, power: 0.3 });
    }, i * 450));
  }, pre + 300);
}

// Вибрация на телефонах, где она есть (Android; Safari на iPhone не поддерживает).
const BUZZ = { task: 18, scope: [25, 60, 25], goal: [40, 60, 40, 60, 90] };
export function vibrate(name) {
  // До первого касания браузер всё равно заблокирует вибрацию и напишет ошибку в консоль.
  if (!calm && navigator.userActivation?.hasBeenActive !== false) navigator.vibrate?.(BUZZ[name]);
}

// Звук: мягкие колокольчики, синтезируются через Web Audio без файлов.
// Включается и выключается кнопкой, выбор запоминается в браузере.
let soundOn = true;
try { soundOn = localStorage.getItem('sound') !== 'off'; } catch {}

let ac = null, master = null;
function audio() {
  if (!ac) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ac = new AC();
    master = ac.createGain();
    master.gain.value = 0.22;
    master.connect(ac.destination);
  }
  if (ac.state === 'suspended') ac.resume();
  return ac;
}
// Браузер разрешает звук только после действия пользователя — включаем по первому клику.
addEventListener('pointerdown', () => { if (soundOn) audio(); }, { capture: true });

function tone(freq, at, len, { type = 'sine', vol = 1, attack = 0.005 } = {}) {
  const o = ac.createOscillator();
  const g = ac.createGain();
  const t = ac.currentTime + at;
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.001, t + len);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + len + 0.05);
}
const semi = (base, n) => base * Math.pow(2, n / 12);

const SOUNDS = {
  task: (k) => { tone(semi(880, k), 0, 0.25, { vol: 0.6 }); tone(semi(1320, k), 0.06, 0.35, { vol: 0.4 }); },
  scope: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.09, 0.9, { type: 'triangle', vol: 0.5 })),
  goal: () => {
    [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, i * 0.11, 1.4, { type: 'triangle', vol: 0.45 }));
    [523, 659, 784].forEach((f) => tone(f, 0.7, 2.2, { vol: 0.35, attack: 0.05 }));
  },
  milestone: () => { tone(784, 0, 0.5, { vol: 0.5 }); tone(1175, 0.12, 0.8, { vol: 0.45 }); },
  note: (n) => tone([523, 587, 659, 784, 880, 1047][n % 6], 0, 0.5, { type: 'triangle', vol: 0.45 }),
};
export function play(name, arg = 0) {
  if (!soundOn || !audio()) return;
  SOUNDS[name](arg);
}

export function initSoundToggle() {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'sound';
  const sync = () => {
    b.textContent = soundOn ? '🔊' : '🔇';
    b.setAttribute('aria-label', soundOn ? 'Выключить звук' : 'Включить звук');
    b.title = b.getAttribute('aria-label');
  };
  sync();
  b.addEventListener('click', () => {
    soundOn = !soundOn;
    try { localStorage.setItem('sound', soundOn ? 'on' : 'off'); } catch {}
    sync();
    play('task');
  });
  document.body.append(b);
}
