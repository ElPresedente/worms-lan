import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, createFlatTerrain, dispatch, step, MOVEMENT, WORM_RADIUS } from '../dist/index.js';
import { intersectsTerrain } from '../dist/terrain.js';
const players = ['alice', 'bob'];
const send = (state, type, extra = {}) => {
  const result = dispatch(state, { type, playerId: 'alice', ...extra });
  assert.equal(result.accepted, true, result.error);
  return result.state;
};
const start = (options = {}) => send(createGame({ players, ...options }), 'start-turn');
function ticks(state, count) {
  for (let i = 0; i < count; i++) {
    state = step(state).state;
    for (const w of state.worms.filter(w => w.health > 0)) {
      assert.equal(intersectsTerrain(state.terrain, w.position, WORM_RADIUS), false, 'body intersects terrain');
    }
  }
  return state;
}
function wall(terrain, x, top, bottom, width = 1) {
  for (let y = top; y < bottom; y++) for (let dx = 0; dx < width; dx++) terrain.cells[y * terrain.width + x + dx] = 1;
}

test('held direction moves only active worm at fixed speed; stop has no drift', () => {
  const initial = start();
  let state = ticks(send(initial, 'move', { direction: 1 }), 60);
  assert.ok(Math.abs(state.worms[0].position.x - initial.worms[0].position.x - MOVEMENT.speed) < 1e-8);
  assert.deepEqual(state.worms[1], initial.worms[1]);
  state = send(state, 'move', { direction: 0 });
  assert.deepEqual(ticks(state, 30).worms[0].position, state.worms[0].position);
  state = ticks(send(state, 'move', { direction: -1 }), 60);
  assert.ok(Math.abs(state.worms[0].position.x - initial.worms[0].position.x) < 1e-8);
  assert.equal(initial.movementDirection, 0);
});

test('movement validates player, phase, life and direction without mutation', () => {
  const waiting = createGame({ players });
  assert.equal(dispatch(waiting, { type: 'jump', playerId: 'alice' }).error, 'wrong-phase');
  const state = start();
  for (const direction of [2, NaN, Infinity, '1', null]) {
    const result = dispatch(state, { type: 'move', playerId: 'alice', direction });
    assert.equal(result.error, 'invalid-action');
    assert.strictEqual(result.state, state);
  }
  assert.equal(dispatch(state, { type: 'jump', playerId: 'bob' }).error, 'wrong-player');
  state.worms[0].health = 0;
  assert.equal(dispatch(state, { type: 'move', playerId: 'alice', direction: 1 }).error, 'invalid-action');
});

test('thin wall, live worm and map edge block walking', () => {
  const terrain = createFlatTerrain(); wall(terrain, 80, 0, 112);
  let state = ticks(send(start({ terrain }), 'move', { direction: 1 }), 100);
  assert.ok(state.worms[0].position.x <= 75);
  state = ticks(send(start({ spawnX: [64, 90] }), 'move', { direction: 1 }), 100);
  assert.ok(state.worms[0].position.x <= 80 + 1e-8);
  state = ticks(send(start(), 'move', { direction: -1 }), 200);
  assert.ok(state.worms[0].position.x >= WORM_RADIUS);
});

test('jump rises, rejects repeated airborne jumps and lands without penetration', () => {
  const initial = start();
  const jump = send(initial, 'jump');
  assert.equal(dispatch(jump, { type: 'jump', playerId: 'alice' }).error, 'invalid-action');
  const rising = ticks(jump, 15);
  assert.ok(rising.worms[0].position.y < initial.worms[0].position.y - 5);
  const landed = ticks(rising, 90);
  assert.equal(landed.worms[0].grounded, true);
  assert.ok(Math.abs(landed.worms[0].position.y - initial.worms[0].position.y) <= 0.25);
  assert.equal(send(landed, 'jump').worms[0].grounded, false);
});

test('ceiling stops ascent and narrow passage prevents entry', () => {
  const terrain = createFlatTerrain(); wall(terrain, 50, 98, 99, 30);
  // Spawn elsewhere, then walk beneath the ceiling whose clearance is only 13 cells.
  const initial = start({ terrain, spawnX: [40, 256] });
  let state = ticks(send(initial, 'move', { direction: 1 }), 60);
  state = ticks(send(send(state, 'move', { direction: 0 }), 'jump'), 10);
  assert.ok(state.worms[0].position.y >= 104);
  assert.ok(state.worms[0].velocity.y >= 0);
  const narrow = createFlatTerrain(); wall(narrow, 90, 90, 104, 30);
  state = ticks(send(start({ terrain: narrow }), 'move', { direction: 1 }), 150);
  assert.ok(state.worms[0].position.x < 90);
});

test('two-cell step and raster slope are walkable', () => {
  const terrain = createFlatTerrain();
  wall(terrain, 80, 110, 112, 25);
  for (let x = 105; x < 145; x++) wall(terrain, x, 110 - Math.floor((x - 105) / 4), 112);
  const state = ticks(send(start({ terrain }), 'move', { direction: 1 }), 190);
  assert.ok(state.worms[0].position.x > 130);
  assert.ok(state.worms[0].position.y < 105);
});

test('walking off support starts falling and falling out finishes the match', () => {
  const terrain = createFlatTerrain();
  for (let y = 0; y < terrain.height; y++) for (let x = 85; x < 180; x++) terrain.cells[y * terrain.width + x] = 0;
  const falling = ticks(send(start({ terrain }), 'move', { direction: 1 }), 70);
  assert.equal(falling.worms[0].grounded, false);
  assert.ok(falling.worms[0].position.y > 107);
  const dead = ticks(falling, 150);
  assert.equal(dead.phase, 'finished');
  assert.equal(dead.winnerId, 'bob');
  assert.equal(dead.movementDirection, 0);
});

test('timeout, pass and shot reset movement; airborne turn ending waits for landing', () => {
  for (const type of ['end-turn', 'fire', 'timeout']) {
    let state = ticks(send(start({ turnDurationSeconds: 1 }), 'move', { direction: 1 }), 50);
    state = send(state, 'jump');
    state = type === 'timeout' ? ticks(state, 10) : send(state, type, { angleDegrees: 90, power: 0 });
    assert.equal(state.phase, 'resolving');
    assert.equal(state.movementDirection, 0);
    assert.equal(state.worms[0].velocity.x, 0);
    assert.equal(dispatch(state, { type: 'move', playerId: 'alice', direction: 1 }).error, 'wrong-phase');
    const events = [];
    while (state.phase === 'resolving' && events.length < 1000) {
      const result = step(state); state = result.state; events.push(...result.events);
      assert.ok(state.tick < 1500);
    }
    assert.equal(events.find(e => e.type === 'turn-ended').reason, type === 'timeout' ? 'timeout' : type === 'fire' ? 'shot' : 'pass');
    assert.equal(state.pendingTurnEnd, null);
    assert.ok(state.worms.every(w => w.health <= 0 || w.grounded));
  }
});

test('moving airborne JSON snapshot and frozen input resume deterministically', () => {
  let state = ticks(send(start(), 'move', { direction: 1 }), 20);
  state = ticks(send(state, 'jump'), 12);
  const snapshot = JSON.parse(JSON.stringify(state));
  function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
  assert.deepEqual(ticks(freeze(state), 90), ticks(snapshot, 90));
});
