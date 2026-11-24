import { TICK_RATE } from '@office-worms/game-core';
import type { GameEvent, GameState } from '@office-worms/game-core';
import type { CommandOutcome, GameSession } from './session.js';
import { Battlefield } from './renderer.js';
import { GameplayControls } from './controls.js';
import { rejectionMessage } from './messages.js';

export interface DebugControls {
  paused(): boolean;
  pause(value: boolean): void;
  step(): void;
  speed(value: number): void;
  reset(map: string, wind: number): void;
}
interface OnlineControls {
  playerId: string;
  names: ReadonlyMap<string, string>;
  leave(): Promise<string>;
  refresh(): Promise<boolean>;
}
interface GameViewOptions {
  debug?: DebugControls;
  online?: OnlineControls;
  browserNavigation?: boolean;
}
const names = new Map([['coral', 'Коралловые'], ['mint', 'Мятные']]);
const phaseNames = { waiting: 'Ожидание игрока', active: 'Ваш ход', resolving: 'Завершение хода', finished: 'Партия завершена' };

function describe(event: GameEvent, name: (id: string) => string): string {
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

/** Renders the shared game interface in a browser or a VS Code webview. */
export function mountGame(root: HTMLElement, session: GameSession, {
  debug, online, browserNavigation = true,
}: GameViewOptions = {}) {
  const name = (id: string) => (online?.names ?? names).get(id) ?? id;
  const wordmark = '<span class="brand-mark" aria-hidden="true"><i></i><i></i></span>office<span>worms</span>';
  const brand = browserNavigation
    ? `<a class="wordmark" href="./" aria-label="Office Worms — главная">${wordmark}</a>`
    : `<div class="wordmark">${wordmark}</div>`;
  let navAction = '';
  if (online) {
    navAction = '<button type="button" class="tool-button nav-action" id="leave-match">Покинуть комнату</button>';
  } else if (browserNavigation) {
    navAction = '<a class="tool-button nav-action" href="?mode=online">Сетевая игра</a>';
  }
  root.innerHTML = `
    <header class="topbar">
      ${brand}
      <div class="mode"><span class="live-dot"></span> ${online ? '<span id="match-connection" role="status">Сетевая партия</span>' : 'Локальный режим <span class="mode-note">/ 2 игрока за одним экраном</span>'}</div>
      ${navAction}
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
          <p class="input-hint" id="command-status" role="status" hidden></p>
          <p class="error" id="error" role="alert" hidden></p>
          ${online ? '<button type="button" class="tool-button" id="refresh-game" hidden>Запросить снимок</button>' : ''}
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
  const controls = new GameplayControls(session, () => true, showOutcome);
  const angle = el<HTMLInputElement>('angle'), power = el<HTMLInputElement>('power');
  const startButton = el<HTMLButtonElement>('start-turn'), fireButton = el<HTMLButtonElement>('fire');
  const pass = el<HTMLButtonElement>('pass'), pause = el<HTMLButtonElement>('pause');
  const tick = el<HTMLButtonElement>('step'), reset = el<HTMLButtonElement>('reset');
  const speed = el<HTMLSelectElement>('speed'), inspector = el<HTMLDetailsElement>('inspector');
  const map = el<HTMLSelectElement>('map'), wind = el<HTMLInputElement>('wind');
  let lastTurn = -1, lastPhase = '', eventCount = 0;
  let pendingActions = 0;
  let reconnecting = false;
  const abort = new AbortController();
  const on = (target: EventTarget, type: string, handler: EventListener) => target.addEventListener(type, handler, { signal: abort.signal });
  function error(message: string): void { el('error').textContent = message; el('error').hidden = !message; }
  function showOutcome(outcome: CommandOutcome): void {
    if (abort.signal.aborted || reconnecting) return;
    if (outcome.kind === 'rejected' || outcome.kind === 'error') error(rejectionMessage(outcome.code));
    if (outcome.kind === 'unknown') {
      error('Сервер не подтвердил команду. Проверьте состояние игры перед следующим действием.');
      if (online) el('refresh-game').hidden = false;
    }
  }
  function aim(): void {
    renderer.angle = Number(angle.value);
    el('angle-value').textContent = angle.value + '°';
    el('power-value').textContent = power.value + '%';
    angle.style.setProperty('--fill', Number(angle.value) / 180 * 100 + '%');
    power.style.setProperty('--fill', power.value + '%');
  }
  function refreshControls(): void {
    const paused = debug?.paused() ?? false;
    pause.textContent = paused ? '▶ Продолжить' : 'Ⅱ Пауза';
    pause.setAttribute('aria-pressed', String(paused));
    tick.disabled = !paused || !debug;
    el('paused-overlay').hidden = !paused;
    const state = session.state;
    const worm = state.worms.find(w => w.playerId === state.players[state.activePlayerIndex] && w.health > 0);
    el<HTMLButtonElement>('move-left').disabled = el<HTMLButtonElement>('move-right').disabled = !worm || !session.canCommand('move');
    el<HTMLButtonElement>('jump').disabled = !worm?.grounded || !session.canCommand('jump');
    fireButton.disabled = !session.canCommand('fire');
    pass.disabled = !session.canCommand('end-turn');
    startButton.hidden = state.phase !== 'waiting' || !session.canControl;
    startButton.disabled = !session.canCommand('start-turn');
    angle.disabled = power.disabled = !session.canControl || state.phase === 'resolving' || state.phase === 'finished';
    renderer.showAim = session.canControl;
    canvas.style.cursor = session.canControl && state.phase === 'active' ? 'crosshair' : 'default';
  }
  function snapshot(state: GameState): void {
    if (!inspector.open) return;
    const { cells, ...terrain } = state.terrain;
    el('snapshot').textContent = JSON.stringify({
      ...state, terrain: { ...terrain, solidCells: cells.reduce((sum, cell) => sum + cell, 0), cells: '[bitmap omitted]' },
    }, null, 2);
  }
  async function send(type: 'start-turn' | 'fire' | 'end-turn'): Promise<void> {
    if (!session.canCommand(type)) return;
    error('');
    const status = el('command-status');
    if (online) {
      pendingActions++;
      status.textContent = 'Ожидаем подтверждение сервера…';
      status.hidden = false;
    }
    const outcome = await session.command(type === 'fire'
      ? { type, angleDegrees: Number(angle.value), power: Number(power.value) / 100 }
      : { type });
    if (online) status.hidden = --pendingActions === 0;
    showOutcome(outcome);
  }
  function log(event: GameEvent, state: GameState): void {
    eventCount++;
    const list = el<HTMLOListElement>('events');
    list.querySelector('.empty-event')?.remove();
    const row = document.createElement('li');
    const stamp = document.createElement('span'); stamp.className = 'event-tick'; stamp.textContent = String(state.tick).padStart(5, '0');
    const kind = document.createElement('code'); kind.textContent = event.type;
    const text = document.createElement('span'); text.className = 'event-message'; text.textContent = describe(event, name);
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
      const team = el('team-' + i);
      team.querySelector('strong')!.textContent = name(worm.playerId);
      if (online) team.querySelector('.team-label')!.textContent = worm.playerId === online.playerId ? 'ВЫ' : 'СОПЕРНИК';
      el('hp-' + i).innerHTML = worm.health + ' <small>HP</small>';
      el('health-' + i).style.width = Math.max(0, Math.min(100, worm.health)) + '%';
      el('team-' + i).classList.toggle('is-active', worm.playerId === playerId && state.phase !== 'finished');
      el('team-' + i).classList.toggle('is-dead', worm.health <= 0);
    }
    const finished = state.phase === 'finished';
    el('turn-label').textContent = 'ХОД ' + String(state.turnNumber).padStart(2, '0');
    el('timer').textContent = state.phase === 'active' ? Math.ceil(state.turnTicksRemaining / TICK_RATE) + 'с' : finished ? '✓' : '—';
    el('timer').classList.toggle('timer-low', state.phase === 'active' && state.turnTicksRemaining < 10 * TICK_RATE);
    const opponent = online && online.playerId !== playerId && (state.phase === 'waiting' || state.phase === 'active');
    const status = finished ? (state.winnerId ? 'Победа · ' + name(state.winnerId) : 'Ничья!') :
      opponent && state.phase === 'active' ? 'Ход соперника' : phaseNames[state.phase];
    el('field-phase').textContent = status;
    el('control-eyebrow').textContent = finished ? 'РЕЗУЛЬТАТ ПАРТИИ' : 'ОЧЕРЕДЬ КОМАНДЫ 0' + (state.activePlayerIndex + 1);
    el('control-title').textContent = finished ? (state.winnerId ? 'Победа · ' + name(state.winnerId) : 'Ничья') : name(playerId);
    el('turn-help').textContent = opponent ? 'Управление станет доступно в ваш ход.' : ({
      waiting: 'Начни ход, когда будешь готов. Таймер пока не идёт.',
      active: 'Двигайся, прыгай, выбери угол и силу. Один выстрел за ход.',
      resolving: 'Ждём взрыва и завершения падений. Ядро считает результат.',
      finished: online ? 'Покиньте комнату, чтобы создать новую партию.' : 'Можно начать новую партию с другой картой или ветром.',
    })[state.phase];
    el('input-hint').textContent = map.value === 'course'
      ? 'Слева направо: ступени → стена → потолок → яма. Клик — прицел, Space — огонь.'
      : map.value === 'falls' ? 'Справа от уступа — глубокое падение. Урон появится при приземлении.'
      : 'Клик по полю — прицел. Space — огонь.';
    el('wind-label').textContent = 'ВЕТЕР ' + (state.wind === 0 ? '· ШТИЛЬ' : (state.wind > 0 ? '→ +' : '← ') + state.wind);
    el('tick-label').textContent = 'TICK ' + String(state.tick).padStart(5, '0');
    if (lastPhase !== state.phase || update.events.some(e => e.type === 'turn-ready')) {
      el('announcement').textContent = status + '. ' + name(playerId);
      lastPhase = state.phase;
    }
    if (online || state.tick % 6 === 0 || update.events.length || update.reset) snapshot(state);
    refreshControls();
  });
  on(angle, 'input', aim); on(power, 'input', aim);
  on(startButton, 'click', () => { void send('start-turn'); canvas.focus(); });
  on(fireButton, 'click', () => { void send('fire'); });
  on(pass, 'click', () => { void send('end-turn'); });
  on(canvas, 'pointerdown', event => {
    if (!session.canControl || session.state.phase !== 'active') return;
    const p = event as PointerEvent;
    const point = renderer.point(p.clientX, p.clientY, session.state);
    const worm = session.state.worms.find(w => w.playerId === session.state.players[session.state.activePlayerIndex] && w.health > 0);
    if (!worm) return;
    angle.value = String(Math.round(Math.max(0, Math.min(180,
      Math.atan2(Math.max(0, worm.position.y - point.y), point.x - worm.position.x) * 180 / Math.PI))));
    aim(); canvas.focus();
  });
  on(pause, 'click', () => { controls.releaseAll(); debug?.pause(!debug.paused()); refreshControls(); });
  on(tick, 'click', () => { debug?.step(); snapshot(session.state); });
  on(speed, 'change', () => debug?.speed(Number(speed.value)));
  on(el('grid'), 'change', () => { renderer.grid = el<HTMLInputElement>('grid').checked; });
  on(el('bodies'), 'change', () => { renderer.bodies = el<HTMLInputElement>('bodies').checked; });
  on(inspector, 'toggle', () => snapshot(session.state));
  on(reset, 'click', () => {
    if (!wind.checkValidity()) { wind.reportValidity(); return; }
    controls.releaseAll(); debug?.reset(map.value, Number(wind.value)); refreshControls();
  });
  on(root, 'keydown', event => {
    const e = event as KeyboardEvent;
    if (e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
    if (e.target instanceof HTMLElement && e.target.closest('input, select, button, summary, textarea, [contenteditable]')) return;
    if (controls.press(e.code, e.repeat)) { e.preventDefault(); return; }
    if (e.code === 'Space' && session.canCommand('fire') && !e.repeat && !debug?.paused()) {
      e.preventDefault(); void send('fire');
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
  if (online) {
    el('clock-note').textContent = 'Таймер работает на сервере, даже когда вкладка скрыта.';
    root.querySelector<HTMLElement>('.settings')!.hidden = true;
    for (const control of [pause, tick, speed, el('grid').parentElement!, el('bodies').parentElement!]) control.hidden = true;
    root.querySelector('.debug-toolbar .eyebrow')!.textContent = 'СОСТОЯНИЕ СЕРВЕРА';
    const leave = el<HTMLButtonElement>('leave-match');
    on(leave, 'click', async () => {
      leave.disabled = true;
      const failure = await online.leave();
      if (!abort.signal.aborted) {
        error(failure);
        leave.disabled = false;
      }
    });
    const refresh = el<HTMLButtonElement>('refresh-game');
    on(refresh, 'click', async () => {
      refresh.disabled = true;
      const updated = await online.refresh();
      if (!abort.signal.aborted) {
        refresh.disabled = false;
        refresh.hidden = updated;
        error(updated ? '' : 'Снимок не получен. Попробуйте ещё раз.');
      }
    });
  }
  aim(); refreshControls();
  let raf = 0;
  const render = (now: number) => { renderer.draw(session.state, now); raf = requestAnimationFrame(render); };
  raf = requestAnimationFrame(render);
  return {
    setConnectionStatus(status: string, restoring: boolean) {
      if (!online) return;
      const indicator = el('match-connection');
      if (indicator.textContent !== status) indicator.textContent = status;
      if (reconnecting === restoring) return;
      reconnecting = restoring;
      el('leave-match').textContent = restoring ? 'Отменить восстановление' : 'Покинуть комнату';
      if (restoring) {
        error('');
        el('refresh-game').hidden = true;
      }
    },
    destroy() {
      if (abort.signal.aborted) return;
      abort.abort();
      cancelAnimationFrame(raf);
      unsubscribe();
      controls.releaseAll();
      root.replaceChildren();
    },
  };
}
