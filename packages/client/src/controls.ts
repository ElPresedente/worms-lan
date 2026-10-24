import type { GameSession, Update } from './session.js';

const directions: Record<string, -1 | 1> = { ArrowLeft: -1, KeyA: -1, ArrowRight: 1, KeyD: 1, left: -1, right: 1 };

/** Translates held inputs to commands. Physics and grounded checks remain in the core. */
export class GameplayControls {
  private held = new Map<string, -1 | 1>();
  constructor(private readonly session: GameSession, private readonly enabled: () => boolean = () => true) {}
  private get active(): boolean { return this.enabled() && this.session.state.phase === 'active'; }
  press(code: string, repeat = false): boolean {
    if (!(code in directions) && code !== 'KeyW' && code !== 'ArrowUp' && code !== 'jump') return false;
    if (!this.active || repeat) return true;
    if (code in directions) {
      this.held.delete(code);
      this.held.set(code, directions[code]!);
      this.move();
    } else {
      this.session.send({ type: 'jump', playerId: this.playerId() });
    }
    return true;
  }
  release(code: string): boolean {
    if (!(code in directions)) return false;
    if (this.held.delete(code)) this.move();
    return true;
  }
  private playerId(): string { return this.session.state.players[this.session.state.activePlayerIndex]!; }
  private move(): void {
    if (!this.active) return;
    const direction = [...this.held.values()].at(-1) ?? 0;
    if (direction !== this.session.state.movementDirection) {
      this.session.send({ type: 'move', playerId: this.playerId(), direction });
    }
  }
  releaseAll(): void {
    this.held.clear();
    if (this.session.state.phase === 'active' && this.session.state.movementDirection !== 0) {
      this.session.send({ type: 'move', playerId: this.playerId(), direction: 0 });
    }
  }
  accept(update: Update): void {
    if (update.reset || update.state.phase !== 'active' || update.events.some(e => e.type === 'turn-started')) {
      this.held.clear();
    }
  }
}
