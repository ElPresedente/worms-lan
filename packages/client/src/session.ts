import type { Action, GameEvent, GameOptions, GameState, Rejection } from '@office-worms/game-core';

export interface Update {
  state: GameState;
  events: readonly GameEvent[];
  reset: boolean;
}
export interface GameSession {
  readonly state: GameState;
  send(action: Action): Rejection | null;
  subscribe(listener: (update: Update) => void): () => void;
}
export type CoreEngine = Pick<typeof import('@office-worms/game-core'), 'createGame' | 'dispatch' | 'step'>;

/** Browser development adapter. A future remote adapter supplies server snapshots. */
export class LocalSession implements GameSession {
  private current: GameState;
  private readonly listeners = new Set<(update: Update) => void>();
  private accumulator = 0;
  private isPaused = false;
  private speed = 1;
  constructor(private readonly core: CoreEngine, options: GameOptions, private readonly tickRate = 60) {
    this.current = core.createGame(options);
  }
  get state(): GameState { return this.current; }
  get paused(): boolean { return this.isPaused; }
  subscribe(listener: (update: Update) => void): () => void {
    this.listeners.add(listener);
    listener({ state: this.current, events: [], reset: true });
    return () => { this.listeners.delete(listener); };
  }
  private publish(events: readonly GameEvent[], reset = false): void {
    for (const listener of this.listeners) listener({ state: this.current, events, reset });
  }
  send(action: Action): Rejection | null {
    const result = this.core.dispatch(this.current, action);
    if (!result.accepted) return result.error;
    this.current = result.state;
    this.publish(result.events);
    return null;
  }
  reset(options: GameOptions): void {
    this.current = this.core.createGame(options);
    this.accumulator = 0;
    this.isPaused = false;
    this.publish([], true);
  }
  setPaused(paused: boolean): void { this.isPaused = paused; this.accumulator = 0; }
  setSpeed(speed: number): void {
    if (![0.25, 0.5, 1].includes(speed)) throw new RangeError('Unsupported playback speed');
    this.speed = speed;
    this.accumulator = 0;
  }
  singleStep(): void {
    if (!this.isPaused) return;
    const result = this.core.step(this.current);
    this.current = result.state;
    this.publish(result.events);
  }
  advance(elapsedMs: number): void {
    if (this.isPaused || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return;
    if (this.current.phase === 'waiting' || this.current.phase === 'finished') {
      this.accumulator = 0;
      return;
    }
    // Bound work after a stalled frame. This is a local debug clock, not server time.
    this.accumulator += Math.min(elapsedMs, 250) * this.speed;
    const tickMs = 1000 / this.tickRate;
    const events: GameEvent[] = [];
    let changed = false;
    while (this.accumulator + 1e-8 >= tickMs) {
      this.accumulator -= tickMs;
      const result = this.core.step(this.current);
      this.current = result.state;
      events.push(...result.events);
      changed = true;
      if (this.current.phase === 'waiting' || this.current.phase === 'finished') {
        this.accumulator = 0;
        break;
      }
    }
    if (changed) this.publish(events);
  }
}
