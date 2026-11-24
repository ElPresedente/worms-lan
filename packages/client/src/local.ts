import { createGame, dispatch, step, TICK_RATE } from '@office-worms/game-core';
import { mountGame } from './app.js';
import { scenario } from './scenarios.js';
import { LocalSession } from './session.js';

export function mountLocal(root: HTMLElement, browserNavigation = true): () => void {
  const session = new LocalSession({ createGame, dispatch, step }, scenario('flat', 0), TICK_RATE);
  const app = mountGame(root, session, {
    browserNavigation,
    debug: {
      paused: () => session.paused,
      pause: value => session.setPaused(value),
      step: () => session.singleStep(),
      speed: value => session.setSpeed(value),
      reset: (map, wind) => session.reset(scenario(map, wind)),
    },
  });
  let lastTime: number | null = null;
  const frame = (now: number) => {
    if (!document.hidden && lastTime !== null) session.advance(now - lastTime);
    lastTime = document.hidden ? null : now;
    raf = requestAnimationFrame(frame);
  };
  const onVisibility = () => { lastTime = null; };
  document.addEventListener('visibilitychange', onVisibility);
  let raf = requestAnimationFrame(frame);
  return () => {
    cancelAnimationFrame(raf);
    document.removeEventListener('visibilitychange', onVisibility);
    app.destroy();
  };
}
