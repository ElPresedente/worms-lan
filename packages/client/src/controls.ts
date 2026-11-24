import type { NetworkAction } from '#protocol';
import type { CommandOutcome, GameSession, Update } from './session.js';

const directions: Record<string, -1 | 1> = { ArrowLeft: -1, KeyA: -1, ArrowRight: 1, KeyD: 1, left: -1, right: 1 };

/** Translates held inputs to commands. Physics and grounded checks remain in the core. */
export class GameplayControls {
  private held = new Map<string, -1 | 1>();
  private direction: -1 | 0 | 1 | undefined;
  private turn = -1;
  constructor(
    private readonly session: GameSession,
    private readonly enabled: () => boolean = () => true,
    private readonly onOutcome: (outcome: CommandOutcome) => void = () => {},
  ) {}
  private get active(): boolean { return this.enabled() && this.session.canControl && this.session.state.phase === 'active'; }
  press(code: string, repeat = false): boolean {
    if (!(code in directions) && code !== 'KeyW' && code !== 'ArrowUp' && code !== 'jump') return false;
    if (!this.active || repeat) return true;
    if (code in directions) {
      this.held.delete(code);
      this.held.set(code, directions[code]!);
      this.move();
    } else if (this.session.canCommand('jump')) this.send({ type: 'jump' });
    return true;
  }
  release(code: string): boolean {
    if (!(code in directions)) return false;
    if (this.held.delete(code)) this.move();
    return true;
  }
  private send(action: NetworkAction): void { void this.session.command(action).then(this.onOutcome); }
  private move(): void {
    if (!this.active) return;
    const direction = [...this.held.values()].at(-1) ?? 0;
    if (this.session.canCommand('move') && direction !== (this.direction ?? this.session.state.movementDirection)) {
      this.direction = direction;
      this.send({ type: 'move', direction });
    }
  }
  releaseAll(): void {
    this.held.clear();
    if (this.session.canCommand('move') && (this.direction ?? this.session.state.movementDirection) !== 0) {
      this.direction = 0;
      this.send({ type: 'move', direction: 0 });
    }
  }
  accept(update: Update): void {
    if (update.reset || !this.session.canControl || update.state.phase !== 'active' || this.turn !== update.state.turnNumber) {
      this.held.clear();
      this.direction = undefined;
    }
    this.turn = update.state.turnNumber;
  }
}
