import { createGame, dispatch, step, TICK_RATE } from '@office-worms/game-core';
import { mountGame } from './app.js';
import { LocalSession } from './session.js';
import { scenario } from './scenarios.js';
import { mountOnline } from './online.js';

const root = document.getElementById('app')!;

function mountLocal(): () => void {
  const session = new LocalSession({ createGame, dispatch, step }, scenario('flat', 0), TICK_RATE);
  const app = mountGame(root, session, {
    paused: () => session.paused,
    pause: value => session.setPaused(value),
    step: () => session.singleStep(),
    speed: value => session.setSpeed(value),
    reset: (map, wind) => session.reset(scenario(map, wind)),
  });
  let lastTime: number | null = null;
  let raf = 0;
  const frame = (now: number) => {
    if (!document.hidden && lastTime !== null) session.advance(now - lastTime);
    lastTime = document.hidden ? null : now;
    raf = requestAnimationFrame(frame);
  };
  const onVisibility = () => { lastTime = null; };
  document.addEventListener('visibilitychange', onVisibility);
  raf = requestAnimationFrame(frame);
  return () => {
    cancelAnimationFrame(raf); document.removeEventListener('visibilitychange', onVisibility); app.destroy();
  };
}

function start(): (() => void) | undefined {
  try {
    return new URLSearchParams(location.search).get('mode') === 'online' ? mountOnline(root) : mountLocal();
  } catch (error) {
    root.replaceChildren();
    const message = document.createElement('p');
    message.setAttribute('role', 'alert');
    message.textContent = 'Не удалось запустить клиент: ' + String(error);
    root.append(message);
    console.error(error);
  }
}

let stop = start();
window.addEventListener('pagehide', () => { stop?.(); stop = undefined; });
window.addEventListener('pageshow', event => { if (event.persisted) stop = start(); });
