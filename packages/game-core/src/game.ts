import { carveCircle, createFlatTerrain, intersectsTerrain, isSolid, validateTerrain } from './terrain.js';
import type { Action, ActionResult, GameEvent, GameOptions, GameState, Transition, Vec2, Worm } from './types.js';

export const TICK_RATE = 60;
export const FIXED_DT = 1 / TICK_RATE;
export const WORM_RADIUS = 5;
export const MOVEMENT = Object.freeze({ speed: 24, jumpSpeed: 38, maxStepHeight: 2 });
export const BAZOOKA = Object.freeze({ minSpeed: 25, maxSpeed: 150, blastRadius: 24, maxDamage: 60 });
export const FALL = Object.freeze({ safeSpeed: 45, damagePerSpeed: 1, maxDamage: 100 });
export const KNOCKBACK = Object.freeze({ maxSpeed: 55, groundDeceleration: 90, airDeceleration: 8 });
export const MAX_RESOLVING_TICKS = 30 * TICK_RATE;
const GRAVITY = 60;
const MAX_PROJECTILE_TICKS = 15 * TICK_RATE;

function copyState(state: GameState): GameState {
  return {
    ...state, players: [...state.players],
    terrain: { ...state.terrain, cells: [...state.terrain.cells] },
    worms: state.worms.map(w => ({ ...w, position: { ...w.position }, velocity: { ...w.velocity } })),
    projectile: state.projectile ? {
      ...state.projectile, position: { ...state.projectile.position }, velocity: { ...state.projectile.velocity },
    } : null,
  };
}
function spawn(terrain: GameState['terrain'], x: number, playerId: string, index: number, health: number): Worm {
  if (!Number.isFinite(x) || x < WORM_RADIUS || x > terrain.width - WORM_RADIUS) {
    throw new RangeError('Spawn x must be inside the map');
  }
  let y = WORM_RADIUS;
  if (intersectsTerrain(terrain, { x, y }, WORM_RADIUS)) throw new RangeError('Spawn blocked at top of map');
  while (y <= terrain.height - WORM_RADIUS &&
    !intersectsTerrain(terrain, { x, y: y + 0.25 }, WORM_RADIUS)) y += 0.25;
  if (y > terrain.height - WORM_RADIUS) throw new RangeError('Spawn needs solid ground');
  return { id: 'worm-' + (index + 1), playerId, position: { x, y },
    velocity: { x: 0, y: 0 }, health, grounded: true };
}
export function createGame(options: GameOptions): GameState {
  const players = options.players;
  if (players.length !== 2 || players.some(id => typeof id !== 'string' || !id.trim()) || players[0] === players[1]) {
    throw new RangeError('Exactly two distinct nonempty player IDs are required');
  }
  const duration = options.turnDurationSeconds ?? 60;
  const wind = options.wind ?? 0;
  const health = options.health ?? 100;
  if (!Number.isInteger(duration) || duration < 1 || duration > 300) throw new RangeError('Turn duration must be 1..300 seconds');
  if (!Number.isFinite(wind) || Math.abs(wind) > 30) throw new RangeError('Wind must be -30..30');
  if (!Number.isInteger(health) || health < 1 || health > 1000) throw new RangeError('Health must be 1..1000');
  const terrain = options.terrain ?? createFlatTerrain();
  validateTerrain(terrain);
  const xs = options.spawnX ?? [terrain.width * 0.2, terrain.width * 0.8];
  const worms = players.map((id, i) => spawn(terrain, xs[i]!, id, i, health));
  if (Math.hypot(worms[0]!.position.x - worms[1]!.position.x,
    worms[0]!.position.y - worms[1]!.position.y) < 2 * WORM_RADIUS) throw new RangeError('Worm spawns overlap');
  return {
    version: 1, tick: 0, phase: 'waiting', players: [...players],
    terrain: { ...terrain, cells: [...terrain.cells] }, worms,
    activePlayerIndex: 0, turnNumber: 1, turnTicksRemaining: 0,
    turnDurationTicks: duration * TICK_RATE, wind, projectile: null, winnerId: null,
    movementDirection: 0, pendingTurnEnd: null, resolvingTicks: 0,
  };
}
function activePlayer(state: GameState): string { return state.players[state.activePlayerIndex]!; }
function stopMovement(state: GameState): void {
  state.movementDirection = 0;
  for (const w of state.worms) w.velocity.x = 0;
}
function requestTurnEnd(state: GameState, events: GameEvent[], reason: 'timeout' | 'pass'): void {
  stopMovement(state);
  state.turnTicksRemaining = 0;
  if (bodiesSettled(state)) finishTurn(state, events, reason);
  else {
    state.phase = 'resolving';
    state.pendingTurnEnd = reason;
    state.resolvingTicks = 0;
  }
}
function finishTurn(state: GameState, events: GameEvent[], reason: 'shot' | 'timeout' | 'pass'): void {
  stopMovement(state);
  state.pendingTurnEnd = null;
  state.resolvingTicks = 0;
  events.push({ type: 'turn-ended', playerId: activePlayer(state), reason });
  state.turnTicksRemaining = 0;
  const alive = state.players.filter(id => state.worms.some(w => w.playerId === id && w.health > 0));
  if (alive.length <= 1) {
    state.phase = 'finished';
    state.winnerId = alive[0] ?? null;
    events.push({ type: 'game-finished', winnerId: state.winnerId });
    return;
  }
  state.activePlayerIndex = (state.activePlayerIndex + 1) % state.players.length;
  state.turnNumber++;
  state.phase = 'waiting';
  events.push({ type: 'turn-ready', playerId: activePlayer(state), turnNumber: state.turnNumber });
}
/** Rejected actions return the original state and never advance simulation time. */
export function dispatch(state: GameState, action: Action): ActionResult {
  const reject = (error: 'game-finished' | 'wrong-player' | 'wrong-phase' | 'invalid-action'): ActionResult =>
    ({ accepted: false, state, events: [], error });
  if (state.phase === 'finished') return reject('game-finished');
  if (action.playerId !== activePlayer(state)) return reject('wrong-player');
  if (action.type === 'start-turn') {
    if (state.phase !== 'waiting') return reject('wrong-phase');
    const next = copyState(state);
    next.phase = 'active';
    next.turnTicksRemaining = next.turnDurationTicks;
    return { accepted: true, state: next, events: [
      { type: 'turn-started', playerId: action.playerId, turnNumber: next.turnNumber },
    ] };
  }
  if (state.phase !== 'active') return reject('wrong-phase');
  const activeWorm = state.worms.find(w => w.playerId === action.playerId && w.health > 0);
  if (!activeWorm) return reject('invalid-action');
  if (action.type === 'move') {
    if (![-1, 0, 1].includes(action.direction)) return reject('invalid-action');
    const next = copyState(state);
    next.movementDirection = action.direction;
    return { accepted: true, state: next, events: [] };
  }
  if (action.type === 'jump') {
    if (!activeWorm.grounded) return reject('invalid-action');
    const next = copyState(state);
    const worm = next.worms.find(w => w.id === activeWorm.id)!;
    worm.velocity.y = -MOVEMENT.jumpSpeed;
    worm.grounded = false;
    return { accepted: true, state: next, events: [] };
  }
  if (action.type === 'fire') {
    if (!Number.isFinite(action.angleDegrees) || action.angleDegrees < 0 || action.angleDegrees > 180 ||
        !Number.isFinite(action.power) || action.power < 0 || action.power > 1) return reject('invalid-action');
    const next = copyState(state);
    const worm = next.worms.find(w => w.playerId === action.playerId && w.health > 0)!;
    // 0 = right, 90 = up, 180 = left. Zero power still has minimum launch speed.
    const angle = action.angleDegrees * Math.PI / 180;
    const speed = BAZOOKA.minSpeed + action.power * (BAZOOKA.maxSpeed - BAZOOKA.minSpeed);
    next.projectile = {
      // Start at the center so terrain between the worm and the muzzle cannot be skipped.
      position: { ...worm.position },
      velocity: { x: Math.cos(angle) * speed, y: -Math.sin(angle) * speed },
      ageTicks: 0, shooterExited: false,
    };
    next.phase = 'resolving';
    stopMovement(next);
    next.pendingTurnEnd = 'shot';
    next.resolvingTicks = 0;
    next.turnTicksRemaining = 0;
    return { accepted: true, state: next, events: [
      { type: 'shot-fired', playerId: action.playerId, position: { ...worm.position } },
    ] };
  }
  if (action.type !== 'end-turn') return reject('invalid-action');
  const next = copyState(state);
  const events: GameEvent[] = [];
  requestTurnEnd(next, events, 'pass');
  return { accepted: true, state: next, events };
}
function damage(worm: Worm, amount: number, events: GameEvent[], cause: Extract<GameEvent, { type: 'damage' }>['cause']): void {
  const actual = Math.min(worm.health, amount);
  if (actual <= 0) return;
  worm.health -= actual;
  events.push({ type: 'damage', wormId: worm.id, amount: actual, cause });
  if (worm.health === 0) {
    worm.velocity = { x: 0, y: 0 };
    events.push({ type: 'worm-died', wormId: worm.id });
  }
}
function explode(state: GameState, position: Vec2, events: GameEvent[]): void {
  const removedCells = carveCircle(state.terrain, position, BAZOOKA.blastRadius);
  events.push({ type: 'explosion', position: { ...position }, radius: BAZOOKA.blastRadius, removedCells });
  for (const worm of state.worms) {
    if (worm.health <= 0) continue;
    const distance = Math.max(0, Math.hypot(worm.position.x - position.x, worm.position.y - position.y) - WORM_RADIUS);
    const amount = Math.max(0, Math.round(BAZOOKA.maxDamage * (1 - distance / BAZOOKA.blastRadius)));
    damage(worm, amount, events, 'explosion');
    const strength = Math.max(0, 1 - distance / BAZOOKA.blastRadius);
    if (worm.health > 0 && strength > 0) {
      const dx = worm.position.x - position.x;
      // A small upward bias lifts bodies away from crater edges, even for level hits.
      const dy = Math.min(-0.35, (worm.position.y - position.y) / Math.max(1, Math.hypot(dx, worm.position.y - position.y)));
      const horizontal = dx / Math.max(1, Math.hypot(dx, worm.position.y - position.y));
      const length = Math.hypot(horizontal, dy);
      worm.velocity.x += horizontal / length * KNOCKBACK.maxSpeed * strength;
      worm.velocity.y += dy / length * KNOCKBACK.maxSpeed * strength;
      worm.grounded = false;
      events.push({ type: 'knockback', wormId: worm.id, velocity: { ...worm.velocity } });
    }
  }
  state.projectile = null;
}
function advanceProjectile(state: GameState, events: GameEvent[]): void {
  const p = state.projectile;
  if (!p) return;
  p.ageTicks++;
  p.velocity.x += state.wind * FIXED_DT;
  p.velocity.y += GRAVITY * FIXED_DT;
  const dx = p.velocity.x * FIXED_DT, dy = p.velocity.y * FIXED_DT;
  // Sweep in <= half-cell steps to catch thin terrain and worm bodies.
  const count = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 0.5));
  const shooter = state.worms.find(w => w.playerId === activePlayer(state))!;
  for (let i = 0; i < count; i++) {
    p.position.x += dx / count;
    p.position.y += dy / count;
    if (Math.hypot(shooter.position.x - p.position.x, shooter.position.y - p.position.y) > WORM_RADIUS) {
      p.shooterExited = true;
    }
    const hitWorm = state.worms.some(w => w.health > 0 &&
      !(w === shooter && !p.shooterExited) &&
      Math.hypot(w.position.x - p.position.x, w.position.y - p.position.y) <= WORM_RADIUS);
    if (isSolid(state.terrain, p.position.x, p.position.y) || hitWorm) {
      explode(state, p.position, events);
      return;
    }
    if (p.position.x < 0 || p.position.x >= state.terrain.width || p.position.y >= state.terrain.height) {
      state.projectile = null;
      return;
    }
  }
  if (p.ageTicks >= MAX_PROJECTILE_TICKS) state.projectile = null;
}
/** Live bodies are solid circles; dead bodies do not block movement. */
function blockedByWorm(state: GameState, worm: Worm, position: Vec2): boolean {
  return state.worms.some(other => other !== worm && other.health > 0 &&
    Math.hypot(other.position.x - position.x, other.position.y - position.y) < 2 * WORM_RADIUS);
}
function blocked(state: GameState, worm: Worm, position: Vec2): boolean {
  if (position.x < WORM_RADIUS || position.x > state.terrain.width - WORM_RADIUS) return true;
  return intersectsTerrain(state.terrain, position, WORM_RADIUS) || blockedByWorm(state, worm, position);
}
function land(worm: Worm, events: GameEvent[]): void {
  const impactSpeed = Math.max(0, worm.velocity.y);
  if (!worm.grounded) events.push({ type: 'worm-landed', wormId: worm.id, impactSpeed });
  worm.grounded = true;
  worm.velocity.y = 0;
  const amount = Math.min(FALL.maxDamage, Math.max(0, Math.floor((impactSpeed - FALL.safeSpeed) * FALL.damagePerSpeed)));
  damage(worm, amount, events, 'fall');
}
function bodiesSettled(state: GameState): boolean {
  return state.worms.every(w => w.health <= 0 || (w.grounded && w.velocity.x === 0 && w.velocity.y === 0 &&
    blocked(state, w, { x: w.position.x, y: w.position.y + 0.25 })));
}
function settleWorms(state: GameState, events: GameEvent[]): void {
  for (const w of state.worms) {
    if (w.health <= 0) continue;
    const walking = state.phase === 'active' && w.playerId === activePlayer(state);
    if (walking) w.velocity.x = state.movementDirection * MOVEMENT.speed;
    else {
      const drag = (w.grounded ? KNOCKBACK.groundDeceleration : KNOCKBACK.airDeceleration) * FIXED_DT;
      w.velocity.x = Math.sign(w.velocity.x) * Math.max(0, Math.abs(w.velocity.x) - drag);
    }
    // Sweep each axis in quarter-cell increments. No traversal through thin walls.
    const dx = w.velocity.x * FIXED_DT;
    const horizontalSteps = Math.max(1, Math.ceil(Math.abs(dx) / 0.25));
    for (let i = 0; i < horizontalSteps && dx !== 0; i++) {
      const target = { x: w.position.x + dx / horizontalSteps, y: w.position.y };
      if (!blocked(state, w, target)) { w.position = target; continue; }
      let climbed = false;
      if (walking && w.grounded && w.velocity.y >= 0 && !blockedByWorm(state, w, target)) {
        for (let rise = 0.25; rise <= MOVEMENT.maxStepHeight; rise += 0.25) {
          // Both the vertical lift and horizontal crossing must be clear.
          if (blocked(state, w, { x: w.position.x, y: w.position.y - rise })) break;
          const raised = { x: target.x, y: target.y - rise };
          if (!blocked(state, w, raised)) { w.position = raised; climbed = true; break; }
        }
      }
      if (!climbed) { w.velocity.x = 0; break; }
    }
    const supported = blocked(state, w, { x: w.position.x, y: w.position.y + 0.25 });
    if (w.velocity.y >= 0 && supported) {
      land(w, events);
      continue;
    }
    w.grounded = false;
    w.velocity.y += GRAVITY * FIXED_DT;
    const dy = w.velocity.y * FIXED_DT;
    const count = Math.max(1, Math.ceil(Math.abs(dy) / 0.25));
    for (let i = 0; i < count; i++) {
      const target = { x: w.position.x, y: w.position.y + dy / count };
      if (blocked(state, w, target)) {
        if (dy >= 0) land(w, events);
        else w.velocity.y = 0;
        break;
      }
      w.position = target;
      if (w.position.y - WORM_RADIUS >= state.terrain.height) {
        damage(w, w.health, events, 'out-of-bounds');
        w.velocity = { x: 0, y: 0 };
        break;
      }
    }
  }
}
/** Exactly one fixed simulation tick. Waiting/finished states are idle. */
export function step(state: GameState): Transition {
  if (state.phase === 'waiting' || state.phase === 'finished') return { state, events: [] };
  const next = copyState(state);
  const events: GameEvent[] = [];
  next.tick++;
  if (next.phase === 'active') {
    settleWorms(next, events);
    next.turnTicksRemaining--;
    if (!next.worms.some(w => w.playerId === activePlayer(next) && w.health > 0)) {
      requestTurnEnd(next, events, 'pass');
    } else if (next.turnTicksRemaining <= 0) requestTurnEnd(next, events, 'timeout');
  } else {
    next.resolvingTicks++;
    advanceProjectile(next, events);
    settleWorms(next, events);
    if (next.resolvingTicks >= MAX_RESOLVING_TICKS && (next.projectile || !bodiesSettled(next))) {
      events.push({ type: 'resolution-limit', ticks: next.resolvingTicks });
      next.projectile = null;
      // Recheck stacks after a supporting body dies, so the bound also covers support chains.
      for (let pass = 0; pass < next.worms.length; pass++) {
        for (const w of next.worms) {
          if (w.health <= 0) continue;
          if (!w.grounded || !blocked(next, w, { x: w.position.x, y: w.position.y + 0.25 })) {
            damage(w, w.health, events, 'resolution-limit');
          } else w.velocity = { x: 0, y: 0 };
        }
      }
    }
    if (!next.projectile && bodiesSettled(next)) finishTurn(next, events, next.pendingTurnEnd ?? 'shot');
  }
  return { state: next, events };
}
