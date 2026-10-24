import { TICK_RATE } from '@office-worms/game-core';
import type { GameEvent, GameState } from '@office-worms/game-core';
import type { GameSession } from './session.js';
import { Battlefield } from './renderer.js';
import { GameplayControls } from './controls.js';

export interface DebugControls {
  paused(): boolean;
  pause(value: boolean): void;
  step(): void;
  speed(value: number): void;
  reset(map: string, wind: number): void;
}
const names: Record<string, string> = { coral: 'Коралловые', mint: 'Мятные' };
const phaseNames = { waiting: 'Ожидание игрока', active: 'Ваш ход', resolving: 'Завершение хода', finished: 'Партия завершена' };
const name = (id: string) => names[id] ?? id;

function describe(event: GameEvent): string {
  switch (event.type) {
    case 'turn-started': return name(event.playerId) + ' начали ход';
    case 'shot-fired': return name(event.playerId) + ' выстрелили';
    case 'explosion': return 'Разрушено клеток: ' + event.removedCells;
    case 'damage': return event.wormId + ' · −' + event.amount + ' HP (' + ({ explosion: 'взрыв', fall: 'падение', 'out-of-bounds': 'за картой', 'resolution-limit': 'предел симуляции' }[event.cause]) + ')';
    case 'knockback': return event.wormId + ' отброшен взрывом';
    case 'worm-landed': return event.wormId + ' приземлился';
    case 'resolution-limit': return 'Достигнут предел разрешения: ' + event.ticks + ' тиков';
    case 'worm-died': return event.wormId + ' погиб';
    case 'turn-ended': return 'Ход завершён: ' + ({ shot: 'выстрел', timeout: 'время вышло', pass: 'пропуск' }[event.reason]);
    case 'turn-ready': return 'Очередь: ' + name(event.playerId);
    case 'game-finished': return event.winnerId ? 'Победили ' + name(event.winnerId) : 'Ничья';
  }
}

/** Portable DOM entrypoint: browser today, the same bundle in a VS Code webview later. */
export function mountGame(root: HTMLElement, session: GameSession, debug?: DebugControls) {
  root.innerHTML = `
    <header class="topbar">
      <a class="wordmark" href="./" aria-label="Office Worms — главная"><span class="brand-mark" aria-hidden="true"><i></i><i></i></span>office<span>worms</span></a>
      <div class="mode"><span class="live-dot"></span> Локальный режим <span class="mode-note">/ 2 игрока за одним экраном</span></div>
      <span class="build-label">ПОЛИГОН 001</span>
    </header>
    <main>
      <div class="page-heading"><div><p class="eyebrow">КОРОТКИЙ ПЕРЕРЫВ. ДЛИННАЯ ПАРТИЯ.</p><h1>Офисная баллистика<span>.</span></h1></div><p class="heading-note">Сделай ход.<br>Почти как работа.</p></div>
      <div class="workspace">
        <section class="arena" aria-label="Игровое поле">
          <div class="scoreboard">
            <div class="team team-coral" id="team-0"><span class="team-dot"></span><div><span class="team-label">КОМАНДА 01</span><strong>Коралловые</strong><div class="health-track"><i id="health-0"></i></div></div><span class="health-number" id="hp-0">100 <small>HP</small></span></div>
            <div class="round"><span id="turn-label">ХОД 01</span><strong id="timer">—</strong></div>
            <div class="team team-mint" id="team-1"><span class="team-dot"></span><div><span class="team-label">КОМАНДА 02</span><strong>Мятные</strong><div class="health-track"><i id="health-1"></i></div></div><span class="health-number" id="hp-1">100 <small>HP</small></span></div>
          </div>
          <div class="battlefield-wrap"><canvas id="battlefield" tabindex="0" role="img" aria-label="Поле боя: A/D или стрелки — ходьба, W или стрелка вверх — прыжок, Space — выстрел"></canvas>
            <div class="field-tag"><span class="live-dot"></span><span id="field-phase">Ожидание игрока</span></div>
            <div class="wind-tag" id="wind-label">ВЕТЕР 0</div>
            <div class="pause-overlay" id="paused-overlay" hidden>ПАУЗА<span>Симуляция остановлена</span></div>
          </div>
          <div class="arena-footer"><span><i class="key">↗</i> A / D или ← / → — ходьба · W / ↑ — прыжок</span><span>320 × 180 <b>·</b> 60 Гц</span></div>
        </section>
        <aside class="control-panel" aria-label="Управление ходом">
          <div class="panel-top"><p class="eyebrow" id="control-eyebrow">ОЧЕРЕДЬ КОМАНДЫ 01</p><h2 id="control-title">Коралловые</h2><p id="turn-help">Начни ход, когда будешь готов. Таймер пока не идёт.</p></div>
          <button class="button button-dark" id="start-turn">Начать ход <span>↗</span></button>
          <div class="movement-controls" role="group" aria-label="Перемещение">
            <button id="move-left" class="tool-button" aria-label="Идти влево">← A</button>
            <button id="jump" class="tool-button">Прыжок W / ↑</button>
            <button id="move-right" class="tool-button" aria-label="Идти вправо">D →</button>
          </div>
          <p class="input-hint" id="input-hint">Клик по полю — прицел. Space — огонь.</p>
          <div class="weapon-label"><span class="weapon-icon" aria-hidden="true">↗</span><div><strong>Базука</strong><span>Один выстрел за ход</span></div><span class="weapon-count">01</span></div>
          <label class="range-label" for="angle">Угол <output id="angle-value" for="angle">25°</output></label>
          <input type="range" id="angle" min="0" max="180" step="1" value="25" aria-label="Угол выстрела">
          <div class="range-ends"><span>0° вправо</span><span>180° влево</span></div>
          <label class="range-label power-label" for="power">Сила <output id="power-value" for="power">30%</output></label>
          <input type="range" id="power" min="0" max="100" step="1" value="30" aria-label="Сила выстрела">
          <div class="range-ends"><span>Минимальная</span><span>Максимальная</span></div>
          <button class="button button-coral" id="fire" disabled>Огонь <span class="key key-dark">Space</span></button>
          <button class="button button-quiet" id="pass" disabled>Пропустить ход →</button>
          <p class="error" id="error" role="alert" hidden></p>
          <div class="settings"><p class="eyebrow">НОВАЯ ПАРТИЯ</p><div class="setting-row"><label for="map">Карта</label><select id="map"><option value="flat">Равнина</option><option value="hills">Холмы</option><option value="course">Полоса препятствий</option><option value="falls">Высота и падения</option></select></div><div class="setting-row"><label for="wind">Ветер</label><input type="number" id="wind" value="0" min="-30" max="30" step="1" aria-label="Ветер новой партии"></div><button class="reset-button" id="reset">↻ Перезапустить матч</button></div>
        </aside>
        <section class="debug-panel" aria-label="Отладка ядра">
          <div class="debug-toolbar"><span class="eyebrow">СИМУЛЯЦИЯ</span><button id="pause" class="tool-button" aria-pressed="false">Ⅱ Пауза</button><button id="step" class="tool-button" disabled>+1 тик</button><select id="speed" aria-label="Скорость симуляции"><option value="1">1× скорость</option><option value="0.5">0.5× скорость</option><option value="0.25">0.25× скорость</option></select><label class="check"><input id="grid" type="checkbox">Сетка</label><label class="check"><input id="bodies" type="checkbox">Коллизии</label><span class="tick-label" id="tick-label">TICK 00000</span></div>
          <div class="debug-content"><div class="event-panel"><div class="section-heading"><h3>События ядра</h3><span id="event-count">0 СОБЫТИЙ</span></div><ol id="events" aria-label="Журнал событий ядра"><li class="empty-event">Матч создан. Ожидаем первого хода.</li></ol></div><details id="inspector"><summary>Снимок состояния <span>{ }</span></summary><pre id="snapshot"></pre></details></div>
        </section>
      </div>
      <footer class="page-footer"><span>Черви ждут. Таблицы подождут.</span><span id="clock-note">Локальная симуляция останавливается в скрытой вкладке.</span></footer>
      <p class="sr-only" id="announcement" aria-live="polite"></p>
    </main>`;
  function el<T extends HTMLElement>(id: string): T {
    const result = root.querySelector<T>('#' + id);
    if (!result) throw new Error('Missing element: ' + id);
    return result;
  }
  const canvas = el<HTMLCanvasElement>('battlefield');
  const renderer = new Battlefield(canvas);
  const controls = new GameplayControls(session, () => !(debug?.paused() ?? false));
  const angle = el<HTMLInputElement>('angle'), power = el<HTMLInputElement>('power');
  const startButton = el<HTMLButtonElement>('start-turn'), fireButton = el<HTMLButtonElement>('fire');
  const pass = el<HTMLButtonElement>('pass'), pause = el<HTMLButtonElement>('pause');
  const tick = el<HTMLButtonElement>('step'), reset = el<HTMLButtonElement>('reset');
  const speed = el<HTMLSelectElement>('speed'), inspector = el<HTMLDetailsElement>('inspector');
  const map = el<HTMLSelectElement>('map'), wind = el<HTMLInputElement>('wind');
  let lastTurn = -1, lastPhase = '', eventCount = 0;
  const abort = new AbortController();
  const on = (target: EventTarget, type: string, handler: EventListener) => target.addEventListener(type, handler, { signal: abort.signal });
  function error(message: string): void { el('error').textContent = message; el('error').hidden = !message; }
  function aim(): void {
    renderer.angle = Number(angle.value);
    el('angle-value').textContent = angle.value + '°';
    el('power-value').textContent = power.value + '%';
    angle.style.setProperty('--fill', Number(angle.value) / 180 * 100 + '%');
    power.style.setProperty('--fill', power.value + '%');
  }
  function debugUI(): void {
    const paused = debug?.paused() ?? false;
    pause.textContent = paused ? '▶ Продолжить' : 'Ⅱ Пауза';
    pause.setAttribute('aria-pressed', String(paused));
    tick.disabled = !paused || !debug;
    el('paused-overlay').hidden = !paused;
    for (const id of ['move-left', 'move-right', 'jump']) {
      const worm = session.state.worms.find(w => w.playerId === session.state.players[session.state.activePlayerIndex] && w.health > 0);
      el<HTMLButtonElement>(id).disabled = paused || session.state.phase !== 'active' || !worm || (id === 'jump' && !worm.grounded);
    }
  }
  function snapshot(state: GameState): void {
    if (!inspector.open) return;
    const { cells, ...terrain } = state.terrain;
    el('snapshot').textContent = JSON.stringify({
      ...state, terrain: { ...terrain, solidCells: cells.reduce((sum, cell) => sum + cell, 0), cells: '[bitmap omitted]' },
    }, null, 2);
  }
  function send(type: 'start-turn' | 'fire' | 'end-turn'): void {
    const playerId = session.state.players[session.state.activePlayerIndex]!;
    const result = session.send(type === 'fire'
      ? { type, playerId, angleDegrees: Number(angle.value), power: Number(power.value) / 100 }
      : { type, playerId });
    error(result ? 'Команда отклонена ядром: ' + result : '');
  }
  function log(event: GameEvent, state: GameState): void {
    eventCount++;
    const list = el<HTMLOListElement>('events');
    list.querySelector('.empty-event')?.remove();
    const row = document.createElement('li');
    const stamp = document.createElement('span'); stamp.className = 'event-tick'; stamp.textContent = String(state.tick).padStart(5, '0');
    const kind = document.createElement('code'); kind.textContent = event.type;
    const text = document.createElement('span'); text.className = 'event-message'; text.textContent = describe(event);
    row.title = JSON.stringify(event);
    row.append(stamp, kind, text); list.prepend(row);
    while (list.children.length > 60) list.lastElementChild?.remove();
    el('event-count').textContent = eventCount + ' СОБЫТИЙ';
  }
  const unsubscribe = session.subscribe(update => {
    const state = update.state, playerId = state.players[state.activePlayerIndex]!;
    renderer.accept(update);
    controls.accept(update);
    if (update.reset) {
      eventCount = 0; lastTurn = -1;
      el('events').innerHTML = '<li class="empty-event">Матч создан. Ожидаем первого хода.</li>';
      el('event-count').textContent = '0 СОБЫТИЙ'; error('');
    }
    if (lastTurn !== state.turnNumber) {
      lastTurn = state.turnNumber; angle.value = state.activePlayerIndex === 0 ? '25' : '155'; aim();
    }
    for (const event of update.events) log(event, state);
    for (const [i, worm] of state.worms.entries()) {
      el('hp-' + i).innerHTML = worm.health + ' <small>HP</small>';
      el('health-' + i).style.width = Math.max(0, Math.min(100, worm.health)) + '%';
      el('team-' + i).classList.toggle('is-active', worm.playerId === playerId && state.phase !== 'finished');
      el('team-' + i).classList.toggle('is-dead', worm.health <= 0);
    }
    const finished = state.phase === 'finished';
    el('turn-label').textContent = 'ХОД ' + String(state.turnNumber).padStart(2, '0');
    el('timer').textContent = state.phase === 'active' ? Math.ceil(state.turnTicksRemaining / TICK_RATE) + 'с' : finished ? '✓' : '—';
    el('timer').classList.toggle('timer-low', state.phase === 'active' && state.turnTicksRemaining < 10 * TICK_RATE);
    const status = finished ? (state.winnerId ? 'Победили ' + name(state.winnerId) : 'Ничья!') : phaseNames[state.phase];
    el('field-phase').textContent = status;
    el('control-eyebrow').textContent = finished ? 'РЕЗУЛЬТАТ ПАРТИИ' : 'ОЧЕРЕДЬ КОМАНДЫ 0' + (state.activePlayerIndex + 1);
    el('control-title').textContent = finished ? (state.winnerId ? name(state.winnerId) + ' победили' : 'Ничья') : name(playerId);
    el('turn-help').textContent = ({
      waiting: 'Начни ход, когда будешь готов. Таймер пока не идёт.',
      active: 'Двигайся, прыгай, выбери угол и силу. Один выстрел за ход.',
      resolving: 'Ждём взрыва и завершения падений. Ядро считает результат.',
      finished: 'Можно начать новую партию с другой картой или ветром.',
    })[state.phase];
    startButton.hidden = state.phase !== 'waiting';
    fireButton.disabled = pass.disabled = state.phase !== 'active';
    el('input-hint').textContent = map.value === 'course'
      ? 'Слева направо: ступени → стена → потолок → яма. Клик — прицел, Space — огонь.'
      : map.value === 'falls' ? 'Справа от уступа — глубокое падение. Урон появится при приземлении.'
      : 'Клик по полю — прицел. Space — огонь.';
    angle.disabled = power.disabled = state.phase === 'resolving' || finished;
    canvas.style.cursor = state.phase === 'active' ? 'crosshair' : 'default';
    el('wind-label').textContent = 'ВЕТЕР ' + (state.wind === 0 ? '· ШТИЛЬ' : (state.wind > 0 ? '→ +' : '← ') + state.wind);
    el('tick-label').textContent = 'TICK ' + String(state.tick).padStart(5, '0');
    if (lastPhase !== state.phase || update.events.some(e => e.type === 'turn-ready')) {
      el('announcement').textContent = status + '. ' + name(playerId);
      lastPhase = state.phase;
    }
    if (state.tick % 6 === 0 || update.events.length || update.reset) snapshot(state);
    debugUI();
  });
  on(angle, 'input', aim); on(power, 'input', aim);
  on(startButton, 'click', () => { send('start-turn'); canvas.focus(); });
  on(fireButton, 'click', () => send('fire'));
  on(pass, 'click', () => send('end-turn'));
  on(canvas, 'pointerdown', event => {
    if (session.state.phase !== 'active') return;
    const p = event as PointerEvent;
    const point = renderer.point(p.clientX, p.clientY, session.state);
    const worm = session.state.worms.find(w => w.playerId === session.state.players[session.state.activePlayerIndex] && w.health > 0)!;
    angle.value = String(Math.round(Math.max(0, Math.min(180,
      Math.atan2(Math.max(0, worm.position.y - point.y), point.x - worm.position.x) * 180 / Math.PI))));
    aim(); canvas.focus();
  });
  on(pause, 'click', () => { controls.releaseAll(); debug?.pause(!debug.paused()); debugUI(); });
  on(tick, 'click', () => { debug?.step(); snapshot(session.state); });
  on(speed, 'change', () => debug?.speed(Number(speed.value)));
  on(el('grid'), 'change', () => { renderer.grid = el<HTMLInputElement>('grid').checked; });
  on(el('bodies'), 'change', () => { renderer.bodies = el<HTMLInputElement>('bodies').checked; });
  on(inspector, 'toggle', () => snapshot(session.state));
  on(reset, 'click', () => {
    if (!wind.checkValidity()) { wind.reportValidity(); return; }
    controls.releaseAll(); debug?.reset(map.value, Number(wind.value)); debugUI();
  });
  on(root, 'keydown', event => {
    const e = event as KeyboardEvent;
    if (e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
    if (e.target instanceof HTMLElement && e.target.closest('input, select, button, summary, textarea, [contenteditable]')) return;
    if (controls.press(e.code, e.repeat)) { e.preventDefault(); return; }
    if (e.code === 'Space' && session.state.phase === 'active' && !e.repeat && !debug?.paused()) {
      e.preventDefault(); send('fire');
    }
  });
  on(window, 'keyup', event => { if (controls.release((event as KeyboardEvent).code)) event.preventDefault(); });
  on(window, 'blur', () => controls.releaseAll());
  on(document, 'visibilitychange', () => { if (document.hidden) controls.releaseAll(); });
  on(canvas, 'blur', () => controls.releaseAll());
  on(el('jump'), 'click', () => { controls.press('jump'); canvas.focus(); });
  for (const [id, code] of [['move-left', 'left'], ['move-right', 'right']] as const) {
    const button = el<HTMLButtonElement>(id);
    on(button, 'pointerdown', event => {
      const e = event as PointerEvent;
      if (e.button !== 0 || button.disabled) return;
      e.preventDefault(); canvas.focus(); button.setPointerCapture(e.pointerId); controls.press(code);
    });
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      on(button, event, () => controls.release(code));
    }
    // Hold Space/Enter on a focused movement button just like a direction key.
    on(button, 'keydown', event => {
      const e = event as KeyboardEvent;
      if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); controls.press(code, e.repeat); }
    });
    on(button, 'keyup', event => {
      const e = event as KeyboardEvent;
      if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); controls.release(code); }
    });
    on(button, 'blur', () => controls.release(code));
  }
  if (!debug) { pause.disabled = tick.disabled = speed.disabled = reset.disabled = true; }
  aim(); debugUI();
  let raf = 0;
  const render = (now: number) => { renderer.draw(session.state, now); raf = requestAnimationFrame(render); };
  raf = requestAnimationFrame(render);
  return { destroy() { controls.releaseAll(); cancelAnimationFrame(raf); unsubscribe(); abort.abort(); root.replaceChildren(); } };
}
