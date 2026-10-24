import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, createFlatTerrain, dispatch, step, TICK_RATE } from '../dist/index.js';

const options = { players: ['alice', 'bob'] };
function command(state, action) {
  const result = dispatch(state, action);
  assert.equal(result.accepted, true, result.error);
  return result;
}
function start(state = createGame(options)) {
  return command(state, { type: 'start-turn', playerId: state.players[state.activePlayerIndex] }).state;
}
function fire(state, angleDegrees = 25, power = 0.3) {
  return command(state, { type: 'fire', playerId: state.players[state.activePlayerIndex], angleDegrees, power }).state;
}
function resolve(initial) {
  let state = initial;
  const events = [];
  for (let i = 0; i < 1200 && state.phase === 'resolving'; i++) {
    const result = step(state);
    state = result.state;
    events.push(...result.events);
  }
  assert.notEqual(state.phase, 'resolving', 'shot must finish in bounded time');
  return { state, events };
}

test('initial state waits indefinitely without spending turn time', () => {
  const state = createGame(options);
  assert.equal(state.phase, 'waiting');
  assert.equal(state.worms.length, 2);
  assert.ok(state.worms.every(w => w.grounded && w.health === 100));
  assert.strictEqual(step(state).state, state);
  assert.equal(state.tick, 0);
  assert.equal(state.turnTicksRemaining, 0);
});
test('only the active player can start; fire requires an active turn', () => {
  const state = createGame(options);
  assert.equal(dispatch(state, { type: 'start-turn', playerId: 'bob' }).error, 'wrong-player');
  const result = dispatch(state, { type: 'fire', playerId: 'alice', angleDegrees: 45, power: 1 });
  assert.equal(result.error, 'wrong-phase');
  assert.strictEqual(result.state, state);
  assert.deepEqual(result.events, []);
});
test('starting twice and firing twice are rejected', () => {
  const active = start();
  assert.equal(active.turnTicksRemaining, 60 * TICK_RATE);
  assert.equal(dispatch(active, { type: 'start-turn', playerId: 'alice' }).error, 'wrong-phase');
  const shot = fire(active);
  assert.equal(dispatch(shot, { type: 'fire', playerId: 'alice', angleDegrees: 45, power: 1 }).error, 'wrong-phase');
  assert.equal(dispatch(shot, { type: 'end-turn', playerId: 'alice' }).error, 'wrong-phase');
});
test('invalid and nonfinite shot parameters do not mutate or advance state', () => {
  const state = start();
  for (const [angleDegrees, power] of [[NaN, 1], [45, Infinity], [-1, 1], [181, 1], [45, -0.1], [45, 1.1]]) {
    const result = dispatch(state, { type: 'fire', playerId: 'alice', angleDegrees, power });
    assert.equal(result.error, 'invalid-action');
    assert.strictEqual(result.state, state);
    assert.deepEqual(result.events, []);
  }
  assert.equal(state.tick, 0);
});
test('timeout occurs exactly on the last active tick and returns to untimed waiting', () => {
  let state = start(createGame({ ...options, turnDurationSeconds: 1 }));
  for (let i = 0; i < TICK_RATE - 1; i++) state = step(state).state;
  assert.equal(state.phase, 'active');
  assert.equal(state.turnTicksRemaining, 1);
  const last = step(state);
  assert.equal(last.state.phase, 'waiting');
  assert.equal(last.state.players[last.state.activePlayerIndex], 'bob');
  assert.equal(last.state.turnNumber, 2);
  assert.equal(last.events[0].reason, 'timeout');
  assert.strictEqual(step(last.state).state, last.state);
});
test('pass emits turn-ended followed by turn-ready; second player rotates back', () => {
  const result = command(start(), { type: 'end-turn', playerId: 'alice' });
  assert.deepEqual(result.events, [
    { type: 'turn-ended', playerId: 'alice', reason: 'pass' },
    { type: 'turn-ready', playerId: 'bob', turnNumber: 2 },
  ]);
  const next = command(start(result.state), { type: 'end-turn', playerId: 'bob' });
  assert.equal(next.state.activePlayerIndex, 0);
  assert.equal(next.state.turnNumber, 3);
});
test('shot hits, carves terrain, damages opponent, settles and rotates turn', () => {
  const initial = start(createGame({ ...options, spawnX: [100, 160] }));
  const before = JSON.stringify(initial);
  const result = resolve(fire(initial));
  const explosion = result.events.find(e => e.type === 'explosion');
  assert.ok(explosion);
  assert.ok(explosion.removedCells > 0);
  assert.ok(result.state.worms[1].health < 100);
  assert.ok(result.state.worms[1].position.y > initial.worms[1].position.y);
  assert.equal(result.state.phase, 'waiting');
  assert.equal(result.state.activePlayerIndex, 1);
  assert.ok(result.state.worms.every(w => w.health <= 0 || w.grounded));
  assert.equal(JSON.stringify(initial), before);
  assert.equal(result.events.at(-1).type, 'turn-ready');
});
test('copying is deep enough for frozen input states, including crater mutation', () => {
  function freeze(value) {
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) freeze(item);
      Object.freeze(value);
    }
    return value;
  }
  const initial = freeze(start(createGame({ ...options, spawnX: [100, 160] })));
  const shot = freeze(fire(initial));
  const next = step(shot).state;
  assert.notStrictEqual(next.worms[0].position, shot.worms[0].position);
  assert.notStrictEqual(next.projectile.position, shot.projectile.position);
  assert.ok(resolve(shot).events.some(e => e.type === 'explosion'));
});
test('swept trajectory collides with a one-cell wall', () => {
  const terrain = createFlatTerrain();
  for (let y = 0; y < 112; y++) terrain.cells[y * terrain.width + 110] = 1;
  const result = resolve(fire(start(createGame({ ...options, terrain, spawnX: [100, 160] })), 0, 1));
  const explosion = result.events.find(e => e.type === 'explosion');
  assert.ok(explosion.position.x >= 110 && explosion.position.x < 111);
});
test('vertical shot can return into shooter and cause self-damage', () => {
  const result = resolve(fire(start(), 90, 0));
  assert.ok(result.events.some(e => e.type === 'damage' && e.wormId === 'worm-1'));
  assert.equal(result.state.worms[1].health, 100);
});
test('last surviving team wins; finished state rejects actions and is idle', () => {
  const result = resolve(fire(start(createGame({ ...options, health: 40 })), 90, 0));
  assert.equal(result.state.phase, 'finished');
  assert.equal(result.state.winnerId, 'bob');
  assert.equal(result.events.filter(e => e.type === 'worm-died').length, 1);
  assert.equal(result.events.at(-1).type, 'game-finished');
  assert.equal(dispatch(result.state, { type: 'start-turn', playerId: 'bob' }).error, 'game-finished');
  assert.strictEqual(step(result.state).state, result.state);
});
test('simultaneous death produces a draw, with no next-turn event', () => {
  const result = resolve(fire(start(createGame({ ...options, spawnX: [100, 111], health: 40 })), 0, 0));
  assert.equal(result.state.phase, 'finished');
  assert.equal(result.state.winnerId, null);
  assert.equal(result.events.filter(e => e.type === 'worm-died').length, 2);
  assert.ok(!result.events.some(e => e.type === 'turn-ready'));
});
test('destroying all support lets a surviving worm fall out and die', () => {
  const terrain = createFlatTerrain(64, 32, 16);
  // A one-cell platform leaves no deep crater rim to land on after knockback.
  terrain.cells.fill(0, 17 * terrain.width);
  const result = resolve(fire(start(createGame({ ...options, terrain, spawnX: [14, 50] })), 0, 1));
  assert.equal(result.state.worms[1].health, 0);
  assert.ok(result.state.worms[1].position.y >= terrain.height);
  assert.equal(result.state.winnerId, 'alice');
});
test('miss outside the map still completes the turn without an explosion', () => {
  const result = resolve(fire(start(), 170, 1));
  assert.equal(result.state.phase, 'waiting');
  assert.equal(result.state.activePlayerIndex, 1);
  assert.ok(!result.events.some(e => e.type === 'explosion'));
});
test('wind changes horizontal acceleration on fixed ticks', () => {
  const left = step(fire(start(createGame({ ...options, wind: -10 })), 90, 1)).state;
  const right = step(fire(start(createGame({ ...options, wind: 10 })), 90, 1)).state;
  assert.ok(left.projectile.position.x < right.projectile.position.x);
  assert.equal(left.projectile.position.y, right.projectile.position.y);
});
test('JSON snapshot round-trip preserves subsequent state and event sequence', () => {
  const shot = fire(start(createGame({ ...options, spawnX: [100, 160], wind: 3 })));
  const snapshot = JSON.parse(JSON.stringify(step(shot).state));
  assert.deepEqual(resolve(snapshot), resolve(step(shot).state));
});
test('same options and action sequence reproduce the same result', () => {
  const play = () => resolve(fire(start(createGame({ ...options, spawnX: [100, 160] }))));
  assert.deepEqual(play(), play());
});
test('creation validates settings, sparse terrain, spawn overlap and missing ground', () => {
  for (const overrides of [
    { players: ['alice', 'alice'] }, { players: ['', 'bob'] },
    { turnDurationSeconds: 0 }, { turnDurationSeconds: 1.5 }, { wind: NaN },
    { health: -1 }, { spawnX: [100, 101] }, { spawnX: [-1, 160] },
  ]) assert.throws(() => createGame({ ...options, ...overrides }), RangeError);
  assert.throws(() => createFlatTerrain(1, 180, 112), RangeError);
  assert.throws(() => createFlatTerrain(64, 32, 32), RangeError);
  const empty = createFlatTerrain(64, 32, 16);
  empty.cells.fill(0);
  assert.throws(() => createGame({ ...options, terrain: empty }), RangeError);
  const sparse = createFlatTerrain();
  delete sparse.cells[0];
  assert.throws(() => createGame({ ...options, terrain: sparse }), RangeError);
});
test('createGame owns a copy of caller-provided terrain', () => {
  const terrain = createFlatTerrain();
  const state = createGame({ ...options, terrain });
  terrain.cells.fill(0);
  assert.ok(state.terrain.cells.some(cell => cell === 1));
});
