export interface Vec2 { x: number; y: number }

/** Row-major bitmap: 0 = air, 1 = solid. x right, y down. */
export interface Terrain { width: number; height: number; cells: number[] }
export interface Worm {
  id: string;
  playerId: string;
  position: Vec2;
  velocity: Vec2;
  health: number;
  grounded: boolean;
}
export interface Projectile {
  position: Vec2;
  velocity: Vec2;
  ageTicks: number;
  shooterExited: boolean;
}
export type Phase = 'waiting' | 'active' | 'resolving' | 'finished';

/** Plain JSON data. Treat as immutable; only the core should produce new states. */
export interface GameState {
  version: 1;
  tick: number;
  phase: Phase;
  players: [string, string];
  terrain: Terrain;
  worms: Worm[];
  activePlayerIndex: number;
  turnNumber: number;
  turnTicksRemaining: number;
  turnDurationTicks: number;
  wind: number;
  projectile: Projectile | null;
  movementDirection: -1 | 0 | 1;
  pendingTurnEnd: 'shot' | 'timeout' | 'pass' | null;
  resolvingTicks: number;
  winnerId: string | null;
}
export type Action =
  | { type: 'start-turn'; playerId: string }
  | { type: 'move'; playerId: string; direction: -1 | 0 | 1 }
  | { type: 'jump'; playerId: string }
  | { type: 'fire'; playerId: string; angleDegrees: number; power: number }
  | { type: 'end-turn'; playerId: string };
export type GameEvent =
  | { type: 'turn-started'; playerId: string; turnNumber: number }
  | { type: 'shot-fired'; playerId: string; position: Vec2 }
  | { type: 'explosion'; position: Vec2; radius: number; removedCells: number }
  | { type: 'damage'; wormId: string; amount: number; cause: 'explosion' | 'fall' | 'out-of-bounds' | 'resolution-limit' }
  | { type: 'knockback'; wormId: string; velocity: Vec2 }
  | { type: 'worm-landed'; wormId: string; impactSpeed: number }
  | { type: 'resolution-limit'; ticks: number }
  | { type: 'worm-died'; wormId: string }
  | { type: 'turn-ended'; playerId: string; reason: 'shot' | 'timeout' | 'pass' }
  | { type: 'turn-ready'; playerId: string; turnNumber: number }
  | { type: 'game-finished'; winnerId: string | null };
export interface Transition { state: GameState; events: GameEvent[] }
export type Rejection = 'game-finished' | 'wrong-player' | 'wrong-phase' | 'invalid-action';
export type ActionResult =
  | (Transition & { accepted: true })
  | (Transition & { accepted: false; error: Rejection });
export interface GameOptions {
  players: readonly [string, string];
  terrain?: Terrain;
  spawnX?: readonly [number, number];
  turnDurationSeconds?: number;
  wind?: number;
  health?: number;
}
